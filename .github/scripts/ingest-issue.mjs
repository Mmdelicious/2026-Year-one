import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const SUB_JSON = path.join(ROOT, "data", "reader-submissions.json");
const SUB_JS = path.join(ROOT, "data", "reader-submissions.js");
const PHOTO_ROOT = path.join(ROOT, "assets", "submissions");
const PAGES_URL = process.env.PAGES_URL || "https://mmdelicious.github.io/2026-Year-one/";
const TITLE_PREFIX = "[猫咪线索]";
const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const ZONE_LABELS = { dorm: "宿舍区", teaching: "教学区", canteen: "食堂", other: "其他" };

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function readField(body, label) {
  const pattern = label.split(/\s+/).map(escapeRegExp).join("\\s*");
  const re = new RegExp("^-\\s*" + pattern + "\\s*[：:]\\s*(.*)$", "m");
  const match = body.match(re);
  return match ? match[1].trim() : "";
}

export function parseIssue(issue) {
  const title = String(issue.title || "");
  if (!title.startsWith(TITLE_PREFIX)) return { skip: true };

  const body = String(issue.body || "");
  const errors = [];
  const name = readField(body, "猫名 / 临时称呼").slice(0, 80);
  const zoneText = readField(body, "区域");
  const zone = Object.keys(ZONE_LABELS).find((key) => ZONE_LABELS[key] === zoneText) ||
    (Object.keys(ZONE_LABELS).includes(zoneText) ? zoneText : "");
  const place = readField(body, "地点描述").slice(0, 200);
  const posText = readField(body, "地图位置");
  const pos = posText.match(/x\s*([0-9.]+)\s*%[，,\s]+y\s*([0-9.]+)\s*%/i);
  const time = readField(body, "目击时间").slice(0, 80);
  const notes = readField(body, "外观 / 备注").slice(0, 2000);
  const consent = readField(body, "提交确认");
  const x = pos ? Number(pos[1]) : NaN;
  const y = pos ? Number(pos[2]) : NaN;

  if (!name) errors.push("缺少「猫名 / 临时称呼」");
  if (!zone) errors.push("「区域」必须是 宿舍区 / 教学区 / 食堂 / 其他");
  if (!pos) errors.push("缺少「地图位置」，应形如 x 50.0%，y 50.0%");
  else if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) {
    errors.push("地图坐标必须在 0–100 之间");
  }
  if (!/已确认|^是$/i.test(consent)) errors.push("缺少「提交确认：已确认公开」");
  if (errors.length) return { skip: false, ok: false, errors };

  const photoUrls = [];
  const patterns = [
    /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g,
    /<img[^>]+src=["'](https?:\/\/[^"']+)["']/g
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(body))) {
      const url = match[1].replace(/&amp;/g, "&");
      if (!photoUrls.includes(url)) photoUrls.push(url);
    }
  }
  const safePhotoUrls = photoUrls.filter((url) =>
    /^https:\/\/(github\.com|[a-z0-9-]+\.githubusercontent\.com)\//i.test(url)
  ).slice(0, MAX_PHOTOS);

  return {
    skip: false,
    ok: true,
    errors: [],
    submission: {
      id: "issue-" + issue.number,
      issue: issue.number,
      nickname: name,
      zone,
      place,
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2)),
      time,
      notes,
      author: issue.user && issue.user.login ? issue.user.login : "",
      sourceUrl: issue.html_url || "",
      createdAt: issue.created_at || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    photoUrls: safePhotoUrls
  };
}

function loadSubmissions() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SUB_JSON, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSubmissions(submissions) {
  const clean = submissions.slice().sort((a, b) => Number(a.issue) - Number(b.issue));
  const json = JSON.stringify(clean, null, 2) + "\n";
  fs.mkdirSync(path.dirname(SUB_JSON), { recursive: true });
  fs.writeFileSync(SUB_JSON, json);
  fs.writeFileSync(SUB_JS, "window.CAMPUS_READER_SUBMISSIONS = " + json + ";\n");
}

function removePhotoDir(issueNumber) {
  fs.rmSync(path.join(PHOTO_ROOT, "issue-" + issueNumber), { recursive: true, force: true });
}

async function downloadPhotos(urls, issueNumber) {
  removePhotoDir(issueNumber);
  if (!urls.length) return [];
  const dir = path.join(PHOTO_ROOT, "issue-" + issueNumber);
  const photos = [];
  for (const url of urls) {
    if (photos.length >= MAX_PHOTOS) break;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "catmap-ingest/1.0" } });
      if (!res.ok) continue;
      const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!type.startsWith("image/")) continue;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > MAX_PHOTO_BYTES) continue;
      const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : type === "image/gif" ? "gif" : "jpg";
      fs.mkdirSync(dir, { recursive: true });
      const relative = "assets/submissions/issue-" + issueNumber + "/photo-" + (photos.length + 1) + "." + ext;
      fs.writeFileSync(path.join(ROOT, relative), buffer);
      photos.push(relative);
    } catch (err) {
      console.warn("photo download failed:", url, err.message);
    }
  }
  return photos;
}

function commentPath() {
  const dir = process.env.RUNNER_TEMP || os.tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "cat-comment.md");
}

function writeComment(text) {
  fs.writeFileSync(commentPath(), text.trim() + "\n");
}

function successComment(sub) {
  const photoText = sub.photos && sub.photos.length
    ? sub.photos.length + " 张"
    : "未检测到（可在 Issue 中拖入图片后编辑）";
  return [
    "已自动收录到「读者补充（未核实）」图层。",
    "",
    "- 猫名：" + sub.nickname,
    "- 区域：" + (ZONE_LABELS[sub.zone] || sub.zone),
    "- 地图位置：x " + sub.x.toFixed(1) + "%，y " + sub.y.toFixed(1) + "%",
    "- 照片：" + photoText,
    "",
    "查看地图：" + PAGES_URL,
    "",
    "维护者关闭此 Issue 会从图层移除；编辑 Issue 会自动更新。"
  ].join("\n");
}

function errorComment(errors) {
  return [
    "自动收录失败，请编辑本 Issue 修正以下字段后保存，工作流会自动重试：",
    "",
    ...errors.map((error) => "- " + error),
    "",
    "字段格式参考：",
    "- 猫名 / 临时称呼：...",
    "- 区域：宿舍区 / 教学区 / 食堂 / 其他",
    "- 地图位置：x 50.0%，y 50.0%",
    "- 提交确认：已确认公开"
  ].join("\n");
}

export async function ingestEvent(event) {
  const issue = event.issue;
  if (!issue) return { skipped: true };
  const action = event.action;

  if (action === "deleted" || action === "closed") {
    const before = loadSubmissions();
    const after = before.filter((sub) => Number(sub.issue) !== Number(issue.number));
    const changed = after.length !== before.length;
    if (changed) saveSubmissions(after);
    removePhotoDir(issue.number);
    if (action === "closed" && changed) {
      writeComment("已从「读者补充（未核实）」图层移除。重新打开 Issue 会自动恢复。");
    }
    return { changed, removed: changed };
  }

  if (!["opened", "edited", "reopened"].includes(action)) return { skipped: true };
  if (!issue.title || !String(issue.title).startsWith(TITLE_PREFIX)) return { skipped: true };
  if (issue.state && issue.state !== "open") return { skipped: true };

  const parsed = parseIssue(issue);
  if (parsed.skip) return { skipped: true };
  if (!parsed.ok) {
    writeComment(errorComment(parsed.errors));
    return { changed: false, invalid: true, errors: parsed.errors };
  }

  const photos = await downloadPhotos(parsed.photoUrls, issue.number);
  const submission = { ...parsed.submission, photo: photos[0] || null, photos };
  const submissions = loadSubmissions().filter((sub) => Number(sub.issue) !== Number(issue.number));
  submissions.push(submission);
  saveSubmissions(submissions);
  writeComment(successComment(submission));
  return { changed: true, submission };
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const result = await ingestEvent(event);
  console.log(JSON.stringify({
    action: event.action,
    issue: event.issue && event.issue.number,
    ...result
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
