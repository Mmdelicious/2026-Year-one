(function () {
  "use strict";

  var DATA = window.CAMPUS_CATS_DATA || {};
  var META = DATA.meta || {};
  var BASEMAP = DATA.basemap || {};
  var CATS = Array.isArray(DATA.cats) ? DATA.cats : [];
  var READER_SUBMISSIONS = Array.isArray(window.CAMPUS_READER_SUBMISSIONS) ? window.CAMPUS_READER_SUBMISSIONS : [];
  (function mergeReaderSubmissions() {
    var groups = {};
    READER_SUBMISSIONS.forEach(function (sub) {
      if (!sub || typeof sub.x !== "number" || typeof sub.y !== "number" || !sub.zone) return;
      var key = normalizeName(sub.nickname) || ("issue-" + sub.issue);
      (groups[key] = groups[key] || []).push(sub);
    });
    var curatedByName = {};
    CATS.forEach(function (cat) {
      if (cat.readerAdded) return;
      [cat.nickname].concat(cat.aliases || []).forEach(function (name) {
        var key = normalizeName(name);
        if (key) curatedByName[key] = cat;
      });
    });
    Object.keys(groups).forEach(function (key) {
      var list = groups[key].slice().sort(compareReaderTime);
      var observations = list.map(function (sub) {
        return {
          x: sub.x,
          y: sub.y,
          date: sub.time || String(sub.createdAt || "").slice(0, 10),
          kind: "reader",
          label: "GitHub Issue #" + sub.issue,
          place: sub.place || "",
          sourceUrl: sub.sourceUrl || "",
          issue: sub.issue,
          author: sub.author || "",
          photo: sub.photo || null,
          confidence: 0.35
        };
      });
      var matched = curatedByName[key];
      if (matched) {
        matched.history = (matched.history || []).concat(observations);
        return;
      }
      var latest = list[list.length - 1];
      var withPhoto = list.slice().reverse().find(function (sub) { return sub.photo; });
      CATS.push({
        id: "R-" + latest.issue,
        nickname: latest.nickname || "读者线索",
        place: latest.place || "",
        zone: latest.zone || "other",
        x: latest.x,
        y: latest.y,
        dx: 26,
        dy: -12,
        photo: (withPhoto && withPhoto.photo) || null,
        sourcePost: "GitHub Issue #" + latest.issue + (latest.author ? " · " + latest.author : ""),
        sourceUrl: latest.sourceUrl || "",
        note: latest.notes || "",
        confidence: 0.35,
        readerAdded: { via: "GitHub Issue", issue: latest.issue, author: latest.author || "", at: latest.createdAt || "" },
        aliases: [],
        history: observations
      });
    });
  })();
  var LOW = typeof META.confidenceThreshold === "number" ? META.confidenceThreshold : 0.6;
  var LANDMARKS = Array.isArray(DATA.landmarks) ? DATA.landmarks : [];
  var PENDING = DATA.pending || { cats: [], sightings: [] };
  var PENDING_CATS = Array.isArray(PENDING.cats) ? PENDING.cats : [];
  var PENDING_SIGHTS = Array.isArray(PENDING.sightings) ? PENDING.sightings : [];
  var MERGES = Array.isArray(DATA.merges) ? DATA.merges : [];
  var SIGHT_SPOTS = Array.isArray(DATA.sightingSpots) ? DATA.sightingSpots : [];
  var EMPTY_BLOCKS = Array.isArray(DATA.emptyBlocks) ? DATA.emptyBlocks : [];

  var ZONES = { dorm: "宿舍区", teaching: "教学区", canteen: "食堂", other: "其他" };
  var ZONE_ORDER = ["all", "dorm", "teaching", "canteen", "other"];

  buildCatHistory();

  var state = {
    zone: "all",
    showLow: true,
    showCats: true,
    showSights: true,
    showInference: true,
    selectedId: null
  };
  var markerEls = {};
  var heatEls = {};

  var stage = document.getElementById("mapStage");
  var layer = document.getElementById("mapLayer");
  var mapFocus = document.getElementById("mapFocus");
  var focusShade = document.getElementById("focusShade");
  var focusFx = document.getElementById("focusFx");
  var focusBadge = document.getElementById("focusBadge");
  var mapStatus = document.getElementById("mapStatus");
  var ISSUE_REPO = "Mmdelicious/2026-Year-one";
  // 近似校区边界：如定位偏差大，可在此校准
  var CAMPUS_GEO = { north: 30.6860, south: 30.6770, west: 103.8154, east: 103.8270 };
  var MAP_BOUNDS = { left: 3.2, right: 96.8, top: 2.6, bottom: 96.2 };
  var ZONE_ANCHORS = { dorm: [[16.5, 11.5], [70.6, 66.7]], teaching: [[62.1, 27.9]], canteen: [[10.2, 47.5]] };
  var contrib = { x: null, y: null, zone: "", photoName: "", photoUrl: "", picking: false, pickReady: false, geoBusy: false };
  var draftMarker = document.getElementById("draftMarker");
  var pickBanner = document.getElementById("pickBanner");
  var catHistoryLayer = document.getElementById("catHistoryLayer");
  var historyBadge = document.getElementById("historyBadge");
  var historyBadgeText = document.getElementById("historyBadgeText");
  var markersBox = document.getElementById("markers");
  var sightBox = document.getElementById("sightMarkers");
  var emptyBlockBox = document.getElementById("emptyBlocks");
  var emptyBox = document.getElementById("mapEmpty");
  var chipsBox = document.getElementById("zoneChips");
  var lowToggle = document.getElementById("lowToggle");
  var catToggle = document.getElementById("catLayerToggle");
  var sightToggle = document.getElementById("sightLayerToggle");
  var inferToggle = document.getElementById("inferToggle");
  var sheet = document.getElementById("sheet");
  var backdrop = document.getElementById("backdrop");
  var countEl = document.getElementById("catCount");
  var totalEl = document.getElementById("catTotal");

  /* ---------- 文案与标识 ---------- */
  var stats = META.stats || {};
  var LANDED = CATS.filter(function (c) { return isPlaced(c); });

  function isPlaced(cat) {
    return !!cat && typeof cat.x === "number" && typeof cat.y === "number";
  }

  function inferable(cat) {
    return !!cat && !!cat.inference &&
      Array.isArray(cat.inference.candidates) && cat.inference.candidates.length > 0;
  }

  function noCue(cat) {
    return !!cat && !!cat.inference && !!cat.inference.noCue;
  }

  function inferableCats() { return CATS.filter(inferable); }

  function initText() {
    if (META.campus) document.getElementById("campusName").textContent = META.campus;
    totalEl.textContent = CATS.length;

    document.getElementById("statPosts").textContent = stats.posts || 0;
    document.getElementById("statCats").textContent = stats.cats || CATS.length;
    document.getElementById("statImages").textContent = stats.images || 0;
    document.getElementById("statInferred").textContent =
      stats.inferredCats || inferableCats().length;
    document.getElementById("statSpots").textContent =
      stats.sightingSpots || SIGHT_SPOTS.length;
    document.getElementById("statPlacedSights").textContent =
      stats.sightingPlaced || 0;
    document.getElementById("statSights").textContent =
      stats.sightings || PENDING_SIGHTS.length;

    var notice = document.getElementById("dataNotice");
    var lines = [];
    if (META.coverage) lines.push(META.coverage);
    if (META.note) lines.push(META.note);
    if (lines.length) {
      notice.textContent = lines.join("｜");
      notice.hidden = false;
    }
    if (META.collectedAt) {
      var d = document.getElementById("footDate");
      if (d) d.textContent = META.collectedAt;
    }
    var noticeSummary = document.getElementById("noticeSummary");
    if (noticeSummary) {
      noticeSummary.textContent = "两遍采集 " + (stats.posts || 0) + " 帖 · 采集于 " + (META.collectedAt || "—");
    }

    document.getElementById("mapSource").textContent =
      META.mapLabel || "底图：柳林校区矢量重绘平面图（示意，不按比例）";
  }

  /* ---------- 底图校准 ---------- */
  function applyCalibration() {
    var w = Number(BASEMAP.width) || 0;
    var h = Number(BASEMAP.height) || 0;
    var ratio = (w > 0 && h > 0) ? w / h : 4 / 3;

    // 舞台比例与原图一致，百分比坐标才能与底图 1:1 对齐
    stage.style.aspectRatio = String(ratio);
    // 桌面端避免地图过高，按视口高度限制宽度（移动端由 100% 宽度兜底）
    stage.style.maxWidth = "calc(86vh * " + ratio.toFixed(4) + ")";

    var left = Number(BASEMAP.left) || 0;
    var top = Number(BASEMAP.top) || 0;
    var scale = Number(BASEMAP.scale);
    if (!isFinite(scale) || scale <= 0) scale = 1;

    layer.style.transform = "translate(" + left + "px, " + top + "px) scale(" + scale + ")";
    // 缩放底图时保持点位徽标尺寸不变
    layer.style.setProperty("--inv", 1 / scale);
  }

  /* ---------- 筛选区 ---------- */
  function positionChipInk(animate) {
    var active = chipsBox.querySelector('.chip[aria-pressed="true"]');
    var ink = chipsBox.querySelector(".chip-ink");
    if (!active || !ink) return;
    if (animate === false) ink.style.transition = "none";
    ink.style.width = active.offsetWidth + "px";
    ink.style.height = active.offsetHeight + "px";
    ink.style.transform = "translate(" + active.offsetLeft + "px, " + active.offsetTop + "px)";
    if (animate === false) { void ink.offsetWidth; ink.style.transition = ""; }
  }

  function syncChips() {
    chipsBox.querySelectorAll(".chip").forEach(function (c) {
      c.setAttribute("aria-pressed", c.dataset.zone === state.zone ? "true" : "false");
    });
    positionChipInk(true);
    if (chipsBox.scrollWidth > chipsBox.clientWidth) {
      var active = chipsBox.querySelector('.chip[aria-pressed="true"]');
      if (active) {
        var target = active.offsetLeft - (chipsBox.clientWidth - active.offsetWidth) / 2;
        chipsBox.scrollTo({ left: Math.max(0, target), behavior: prefersReducedMotion() ? "auto" : "smooth" });
      }
    }
  }

  function setZone(key) {
    state.zone = key;
    syncChips();
    render();
    if (typeof updateZoneFocus === "function") {
      try { updateZoneFocus(); } catch (e) { /* 动画失败不影响筛选 */ }
    }
  }

  function bindChips() {
    chipsBox.addEventListener("click", function (e) {
      var btn = e.target.closest(".chip");
      if (!btn || !chipsBox.contains(btn) || !btn.dataset.zone) return;
      btn.classList.remove("is-pulsing");
      void btn.offsetWidth;
      btn.classList.add("is-pulsing");
      setTimeout(function () { btn.classList.remove("is-pulsing"); }, 650);
      setZone(btn.dataset.zone);
    });
    chipsBox.querySelectorAll(".chip").forEach(function (btn) {
      btn.setAttribute("aria-controls", "mapStage");
    });
    window.addEventListener("resize", function () {
      positionChipInk(false);
      scheduleLabelCollision();
      if (state.zone !== "all") updateZoneFocus();
    });
    if (window.ResizeObserver) {
      new ResizeObserver(function () { positionChipInk(false); }).observe(chipsBox);
      new ResizeObserver(function () {
        scheduleLabelCollision();
        if (state.zone !== "all") updateZoneFocus();
      }).observe(stage);
    }
  }

  /* ---------- 区域聚焦 ---------- */
  var focusTimer = null;
  var labelRaf = null;

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function zonePointList(zone) {
    var pts = [];
    CATS.forEach(function (c) {
      if (!c) return;
      if (!c.mergedInto && c.zone === zone && isPlaced(c)) pts.push([c.x, c.y]);
      var inf = c.inference;
      if (inf && Array.isArray(inf.candidates)) {
        inf.candidates.forEach(function (cd) {
          if (cd && cd.zone === zone && typeof cd.x === "number" && typeof cd.y === "number") {
            pts.push([cd.x, cd.y]);
          }
        });
      }
    });
    SIGHT_SPOTS.forEach(function (s) {
      if (s && s.zone === zone && typeof s.x === "number" && typeof s.y === "number") pts.push([s.x, s.y]);
    });
    return pts;
  }

  function zoneFocusGeometry(zone) {
    var pts = [];
    if (state.showCats) {
      visibleCats().forEach(function (c) {
        if (isPlaced(c)) pts.push([c.x, c.y]);
      });
    }
    if (state.showInference) {
      visibleInferPoints().forEach(function (p) {
        if (p.cand && typeof p.cand.x === "number") pts.push([p.cand.x, p.cand.y]);
      });
    }
    if (state.showSights) {
      visibleSpots().forEach(function (s) {
        if (typeof s.x === "number" && typeof s.y === "number") pts.push([s.x, s.y]);
      });
    }
    if (!pts.length) pts = zonePointList(zone);
    if (!pts.length) {
      var block = null;
      EMPTY_BLOCKS.forEach(function (b) { if (!block && b.id === zone) block = b; });
      if (block) {
        return { x1: block.x, y1: block.y, x2: block.x + block.w, y2: block.y + block.h, count: 0, empty: true };
      }
      return null;
    }
    var minX = 100, maxX = 0, minY = 100, maxY = 0;
    pts.forEach(function (p) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    });
    var pad = 4;
    var x1 = Math.max(0, minX - pad), x2 = Math.min(100, maxX + pad);
    var y1 = Math.max(0, minY - pad), y2 = Math.min(100, maxY + pad);
    var minSize = 16;
    if (x2 - x1 < minSize) {
      var ccx = (x1 + x2) / 2;
      x1 = Math.max(0, ccx - minSize / 2);
      x2 = Math.min(100, ccx + minSize / 2);
    }
    if (y2 - y1 < minSize) {
      var ccy = (y1 + y2) / 2;
      y1 = Math.max(0, ccy - minSize / 2);
      y2 = Math.min(100, ccy + minSize / 2);
    }
    return { x1: x1, y1: y1, x2: x2, y2: y2, count: pts.length, empty: false };
  }

  function updateZoneFocus() {
    if (state.zone === "all") { resetZoneFocus(); return; }
    var geom = zoneFocusGeometry(state.zone);
    if (!geom) { resetZoneFocus(); return; }
    var W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) { resetZoneFocus(); return; }

    var cx = (geom.x1 + geom.x2) / 2 / 100 * W;
    var cy = (geom.y1 + geom.y2) / 2 / 100 * H;
    var bw = (geom.x2 - geom.x1) / 100 * W;
    var bh = (geom.y2 - geom.y1) / 100 * H;
    var z = Math.max(1, Math.min(1.6, 0.72 * W / bw, 0.72 * H / bh));
    var span = Math.max(geom.x2 - geom.x1, geom.y2 - geom.y1);
    if (span > 74) z = 1.1;
    else if (span > 62) z = Math.min(z, 1.15);

    var tx = Math.max(W * (1 - z), Math.min(0, W / 2 - z * cx));
    var ty = Math.max(H * (1 - z), Math.min(0, H / 2 - z * cy));

    mapFocus.style.transform = "translate3d(" + tx.toFixed(1) + "px, " + ty.toFixed(1) + "px, 0) scale(" + z.toFixed(4) + ")";
    mapFocus.style.setProperty("--finv", String(1 / z));
    mapFocus.classList.add("is-focusing");
    stage.classList.add("is-focused");

    focusShade.style.setProperty("--fx", ((geom.x1 + geom.x2) / 2).toFixed(2) + "%");
    focusShade.style.setProperty("--fy", ((geom.y1 + geom.y2) / 2).toFixed(2) + "%");
    focusShade.style.setProperty("--frx", Math.min(72, (geom.x2 - geom.x1) / 2 + 10).toFixed(2) + "%");
    focusShade.style.setProperty("--fry", Math.min(72, (geom.y2 - geom.y1) / 2 + 10).toFixed(2) + "%");

    focusFx.style.left = geom.x1 + "%";
    focusFx.style.top = geom.y1 + "%";
    focusFx.style.width = (geom.x2 - geom.x1) + "%";
    focusFx.style.height = (geom.y2 - geom.y1) + "%";
    focusFx.classList.toggle("is-empty-zone", !!geom.empty);
    focusFx.classList.toggle("is-wide", span > 55 && !geom.empty);
    markersBox.querySelectorAll(".marker").forEach(function (el) { el.classList.add("is-zone-focus"); });
    sightBox.querySelectorAll(".heat").forEach(function (el) { el.classList.add("is-zone-focus"); });

    var label = zoneLabel(state.zone);
    focusBadge.hidden = false;
    focusBadge.classList.toggle("is-empty", !!geom.empty);
    focusBadge.textContent = geom.empty
      ? label + " · 暂无点位，待补充"
      : label + " · " + geom.count + " 个标记";
    if (mapStatus) {
      mapStatus.textContent = geom.empty
        ? "已聚焦" + label + "，该区域暂无点位"
        : "已聚焦" + label + "，共 " + geom.count + " 个标记";
    }

    if (focusTimer) clearTimeout(focusTimer);
    focusTimer = setTimeout(function () {
      mapFocus.classList.remove("is-focusing");
      scheduleLabelCollision();
    }, prefersReducedMotion() ? 0 : 700);
    scheduleLabelCollision();
    maybeScrollMapIntoView();
  }

  function resetZoneFocus() {
    if (focusTimer) { clearTimeout(focusTimer); focusTimer = null; }
    stage.classList.remove("is-focused");
    mapFocus.classList.remove("is-focusing");
    mapFocus.style.transform = "";
    mapFocus.style.setProperty("--finv", "1");
    focusBadge.hidden = true;
    focusFx.classList.remove("is-empty-zone");
    focusFx.classList.remove("is-wide");
    document.querySelectorAll(".is-zone-focus").forEach(function (el) { el.classList.remove("is-zone-focus"); });
    if (mapStatus) mapStatus.textContent = "已显示全部区域";
    scheduleLabelCollision();
    setTimeout(scheduleLabelCollision, prefersReducedMotion() ? 0 : 700);
  }

  function maybeScrollMapIntoView() {
    if (window.innerWidth > 700) return;
    var r = stage.getBoundingClientRect();
    if (r.top >= 0 && r.bottom <= window.innerHeight) return;
    stage.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "nearest" });
  }

  function afterLayerChange() {
    render();
    if (state.zone !== "all") updateZoneFocus();
    scheduleLabelCollision();
  }

  function scheduleLabelCollision() {
    if (labelRaf) cancelAnimationFrame(labelRaf);
    labelRaf = requestAnimationFrame(function () {
      labelRaf = null;
      collideLabels();
    });
  }

  function collideLabels() {
    var items = [];
    function collect(box, selector, basePriority) {
      box.querySelectorAll(selector).forEach(function (el) {
        var label = el.querySelector(".marker-label, .heat-label");
        if (!label) return;
        var pri = basePriority;
        if (el.classList.contains("is-active")) pri = 0;
        else if (el.classList.contains("is-infer")) pri = 3;
        else if (el.classList.contains("is-low")) pri = 2;
        items.push({ label: label, priority: pri, order: items.length });
      });
    }
    collect(markersBox, ".marker", 1);
    collect(sightBox, ".heat", 4);
    items.forEach(function (it) { it.label.classList.remove("is-label-hidden"); });
    var placed = [];
    items.sort(function (a, b) { return a.priority - b.priority || a.order - b.order; });
    items.forEach(function (it) {
      var r = it.label.getBoundingClientRect();
      if (!r.width || !r.height) { it.label.classList.add("is-label-hidden"); return; }
      var hit = placed.some(function (p) {
        return !(r.right + 3 < p.left || r.left - 3 > p.right || r.bottom + 3 < p.top || r.top - 3 > p.bottom);
      });
      if (hit) it.label.classList.add("is-label-hidden");
      else placed.push(r);
    });
  }

  /* ---------- 历史足迹与统计 ---------- */
  var PLACE_ALIASES = {
    "晨曦操场后面": "晨曦体育场",
    "晨曦操场": "晨曦体育场",
    "敏园外": "敏园",
    "食堂片区": "食堂",
    "五谷堂片区": "五谷堂",
    "校医院片区": "校医院"
  };

  function normalizeName(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
  }

  function compareReaderTime(a, b) {
    var ka = String(a.time || a.createdAt || "");
    var kb = String(b.time || b.createdAt || "");
    if (ka !== kb) return ka.localeCompare(kb);
    return Number(a.issue) - Number(b.issue);
  }

  function latestDate(value) {
    var dates = String(value || "").match(/20\d{2}-\d{2}-\d{2}/g);
    return dates ? dates.slice().sort().pop() : "";
  }

  function compareHistory(a, b) {
    var da = String(a.date || "");
    var db = String(b.date || "");
    if (da && db && da !== db) return da.localeCompare(db);
    if (da && !db) return -1;
    if (!da && db) return 1;
    var rank = { verified: 0, reader: 1, inferred: 2 };
    return (rank[a.kind] || 0) - (rank[b.kind] || 0);
  }

  function compareHistoryDesc(a, b) {
    var da = String(a.date || "");
    var db = String(b.date || "");
    if (da && db && da !== db) return db.localeCompare(da);
    if (da && !db) return -1;
    if (!da && db) return 1;
    var rank = { verified: 0, reader: 1, inferred: 2 };
    return (rank[a.kind] || 0) - (rank[b.kind] || 0);
  }

  function buildCatHistory() {
    CATS.forEach(function (cat) {
      if (!cat.history) cat.history = [];
      if (!cat.readerAdded && isPlaced(cat) && !cat.history.some(function (o) { return o.kind === "verified"; })) {
        cat.history.push({
          x: cat.x,
          y: cat.y,
          date: latestDate(cat.sourcePost) || META.collectedAt || "",
          kind: "verified",
          label: "整理落点",
          place: cat.place || "",
          sourceUrl: cat.sourceUrl || "",
          confidence: cat.confidence
        });
      }
      if (cat.inference && Array.isArray(cat.inference.candidates)) {
        cat.inference.candidates.forEach(function (cand) {
          if (!cand || typeof cand.x !== "number" || typeof cand.y !== "number") return;
          var exists = cat.history.some(function (o) {
            return o.kind === "inferred" && o.x === cand.x && o.y === cand.y && o.place === (cand.name || "");
          });
          if (exists) return;
          cat.history.push({
            x: cand.x,
            y: cand.y,
            date: "",
            kind: "inferred",
            label: "图片推断 · " + (cand.name || ""),
            place: cand.name || "",
            sourceUrl: "",
            confidence: cand.confidence
          });
        });
      }
      cat.history.sort(compareHistory);
    });
  }

  function canonicalPlace(value) {
    var text = String(value || "").trim();
    if (!text) return "未标注";
    var aliasKeys = Object.keys(PLACE_ALIASES);
    for (var i = 0; i < aliasKeys.length; i++) {
      if (text.indexOf(aliasKeys[i]) >= 0) return PLACE_ALIASES[aliasKeys[i]];
    }
    var best = "";
    LANDMARKS.forEach(function (landmark) {
      if (landmark && landmark.name && text.indexOf(landmark.name) >= 0 && landmark.name.length > best.length) {
        best = landmark.name;
      }
    });
    if (best) return best;
    text = text.replace(/[（(].*?[)）]/g, "").replace(/\/.*$/, "");
    text = text.replace(/(楼下|门口|外面|附近|后面|东侧|西侧|南侧|北侧|片区|一带|周围|旁边)$/g, "").trim();
    return text || "未标注";
  }

  function renderStats() {
    var catBox = document.getElementById("catStats");
    var placeBox = document.getElementById("placeStats");
    if (!catBox || !placeBox) return;

    var cats = CATS.filter(function (cat) {
      return !cat.mergedInto && cat.history && cat.history.length;
    });
    var catRows = cats.map(function (cat) {
      var history = cat.history.slice();
      var verified = history.filter(function (o) { return o.kind === "verified"; }).length;
      var reader = history.filter(function (o) { return o.kind === "reader"; }).length;
      var inferred = history.filter(function (o) { return o.kind === "inferred"; }).length;
      var places = {};
      history.forEach(function (o) { places[canonicalPlace(o.place || cat.place)] = 1; });
      var last = history.map(function (o) { return o.date || ""; }).filter(Boolean).sort().pop() || "";
      return {
        cat: cat,
        total: history.length,
        verified: verified,
        reader: reader,
        inferred: inferred,
        places: Object.keys(places).length,
        placeList: Object.keys(places),
        last: last
      };
    }).sort(function (a, b) {
      return b.total - a.total || a.cat.nickname.localeCompare(b.cat.nickname);
    });

    var maxTotal = Math.max.apply(null, catRows.map(function (r) { return r.total; }).concat([1]));
    var noLoc = CATS.filter(function (cat) {
      return !cat.mergedInto && !(cat.history && cat.history.length);
    }).length;
    var summary = document.getElementById("catStatsSummary");
    if (summary) {
      summary.textContent = catRows.length + " 只有可定位记录 · " +
        catRows.reduce(function (sum, r) { return sum + r.total; }, 0) + " 条记录" +
        (noLoc ? " · " + noLoc + " 只暂无可定位记录" : "");
    }
    var catCount = document.getElementById("catStatsCount");
    if (catCount) catCount.textContent = catRows.length + " 只";

    catBox.textContent = "";
    catRows.forEach(function (row) {
      var el = makeEl("button", "stat-row cat-stat");
      el.type = "button";
      el.title = "在地图上查看 " + row.cat.nickname + " 的足迹";
      el.addEventListener("click", function () { showCatHistory(row.cat.id); });
      el.appendChild(makeEl("span", "sr-name", row.cat.nickname));
      el.appendChild(makeEl("span", "sr-count", row.total + " 条"));
      var placeText = row.placeList.length
        ? row.placeList.slice(0, 3).join(" / ") + (row.placeList.length > 3 ? " 等" : "")
        : "地点未记";
      el.appendChild(makeEl("span", "sr-meta",
        (ZONES[row.cat.zone] || "未分区") + " · " + placeText +
        (row.last ? " · 最后 " + row.last : "")));
      var bar = makeEl("span", "sr-bar");
      var fill = makeEl("i");
      fill.style.width = Math.round(row.total / maxTotal * 100) + "%";
      bar.appendChild(fill);
      el.appendChild(bar);
      el.appendChild(makeEl("span", "sr-break",
        "已核实 " + row.verified + " · 读者 " + row.reader + " · 推断 " + row.inferred));
      catBox.appendChild(el);
    });
    if (!catRows.length) catBox.appendChild(makeEl("p", "stats-empty", "暂无可定位记录。"));

    var buckets = {};
    catRows.forEach(function (row) {
      row.cat.history.forEach(function (o) {
        var name = canonicalPlace(o.place || row.cat.place);
        var bucket = buckets[name] || (buckets[name] = {
          name: name, cats: {}, records: 0, verified: 0, reader: 0, inferred: 0, sightings: 0
        });
        bucket.records++;
        if (o.kind === "verified") {
          bucket.verified++;
          bucket.cats[row.cat.id] = 1;
        } else if (o.kind === "reader") {
          bucket.reader++;
          bucket.cats[row.cat.id] = 1;
        } else {
          bucket.inferred++;
        }
      });
    });
    SIGHT_SPOTS.forEach(function (spot) {
      var name = canonicalPlace(spot.name);
      var bucket = buckets[name] || (buckets[name] = {
        name: name, cats: {}, records: 0, verified: 0, reader: 0, inferred: 0, sightings: 0
      });
      var count = Number(spot.count) || 1;
      bucket.sightings += count;
      bucket.records += count;
    });
    var placeRows = Object.keys(buckets).map(function (key) {
      var bucket = buckets[key];
      return {
        name: bucket.name,
        cats: Object.keys(bucket.cats).length,
        records: bucket.records,
        sightings: bucket.sightings,
        verified: bucket.verified,
        reader: bucket.reader,
        inferred: bucket.inferred
      };
    }).sort(function (a, b) {
      return b.cats - a.cats || b.records - a.records || a.name.localeCompare(b.name);
    });
    var maxCats = Math.max.apply(null, placeRows.map(function (r) { return r.cats; }).concat([0]));
    var maxRecords = Math.max.apply(null, placeRows.map(function (r) { return r.records; }).concat([1]));
    var placeCount = document.getElementById("placeStatsCount");
    if (placeCount) placeCount.textContent = placeRows.length + " 个地点";

    placeBox.textContent = "";
    placeRows.slice(0, 12).forEach(function (row) {
      var el = makeEl("div", "stat-row place-stat");
      el.appendChild(makeEl("span", "sr-name", row.name));
      el.appendChild(makeEl("span", "sr-count", row.cats + " 只猫"));
      el.appendChild(makeEl("span", "sr-meta",
        "记录 " + row.records + " 条 · 目击 " + row.sightings + " · 推断 " + row.inferred));
      var bar = makeEl("span", "sr-bar");
      var fill = makeEl("i");
      var value = row.cats > 0 ? row.cats / Math.max(1, maxCats) : row.records / maxRecords;
      fill.style.width = Math.round(value * 100) + "%";
      bar.appendChild(fill);
      el.appendChild(bar);
      el.appendChild(makeEl("span", "sr-break",
        "已核实 " + row.verified + " · 读者 " + row.reader));
      placeBox.appendChild(el);
    });
    if (!placeRows.length) placeBox.appendChild(makeEl("p", "stats-empty", "暂无地点记录。"));
  }

  function buildHistoryBox(cat) {
    var history = (cat.history || []).slice();
    if (!history.length) return null;
    var box = makeEl("div", "history-box");
    var head = makeEl("div", "history-head");
    head.appendChild(makeEl("b", null, "历史足迹"));
    head.appendChild(makeEl("span", null, history.length + " 条可定位记录"));
    box.appendChild(head);
    var list = makeEl("div", "history-list");
    history.sort(compareHistoryDesc).forEach(function (o) {
      var row = makeEl("div", "history-item");
      row.appendChild(makeEl("span", "history-date", o.date || "日期未记"));
      row.appendChild(makeEl("span", "history-kind is-" + o.kind,
        o.kind === "verified" ? "整理落点" : (o.kind === "reader" ? "读者线索" : "图片推断")));
      row.appendChild(makeEl("span", "history-place", o.place || zoneLabel(cat.zone)));
      if (o.sourceUrl) {
        var link = makeEl("a", "mini-link", "来源");
        link.href = o.sourceUrl;
        link.target = "_blank";
        link.rel = "noreferrer";
        row.appendChild(link);
      }
      if (o.photo) {
        var thumb = makeEl("img", "history-thumb");
        thumb.src = o.photo;
        thumb.alt = "目击照片";
        thumb.loading = "lazy";
        row.appendChild(thumb);
      }
      list.appendChild(row);
    });
    box.appendChild(list);
    var view = makeEl("button", "supp-btn", "在地图上查看足迹");
    view.type = "button";
    view.addEventListener("click", function () {
      closeSheet();
      showCatHistory(cat.id);
    });
    box.appendChild(view);
    return box;
  }

  function showCatHistory(catId) {
    var cat = catById(catId);
    if (!cat || !cat.history || !cat.history.length) return;
    var history = cat.history.slice().sort(compareHistory);
    var path = history.filter(function (o) { return o.kind !== "inferred"; });
    var line = document.getElementById("historyLine");
    if (line) {
      line.setAttribute("points", path.map(function (o) { return o.x + "," + o.y; }).join(" "));
      line.style.display = path.length > 1 ? "" : "none";
    }
    var dots = document.getElementById("historyDots");
    if (dots) {
      dots.textContent = "";
      history.forEach(function (o) {
        var dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        dot.setAttribute("cx", o.x);
        dot.setAttribute("cy", o.y);
        dot.setAttribute("r", o.kind === "inferred" ? 1.05 : 1.35);
        dot.setAttribute("class", "history-dot is-" + o.kind);
        var title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        title.textContent = (o.date || "日期未记") + " · " +
          (o.label || (o.kind === "verified" ? "整理落点" : (o.kind === "reader" ? "读者线索" : "图片推断"))) +
          (o.place ? " · " + o.place : "");
        dot.appendChild(title);
        dots.appendChild(dot);
      });
    }
    if (catHistoryLayer) catHistoryLayer.hidden = false;
    if (historyBadge) historyBadge.hidden = false;
    if (historyBadgeText) historyBadgeText.textContent = cat.nickname + " · " + history.length + " 条记录";
    stage.classList.add("has-history");
    stage.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
  }

  function clearCatHistory() {
    if (catHistoryLayer) catHistoryLayer.hidden = true;
    if (historyBadge) historyBadge.hidden = true;
    stage.classList.remove("has-history");
    var line = document.getElementById("historyLine");
    if (line) line.setAttribute("points", "");
    var dots = document.getElementById("historyDots");
    if (dots) dots.textContent = "";
  }


  /* ---------- 渲染点位 ---------- */
  function isHighConfidence(cat) {
    var conf = typeof cat.confidence === "number" ? cat.confidence : 0;
    return conf >= LOW;
  }

  function visibleCats() {
    return CATS.filter(function (cat) {
      if (!isPlaced(cat) || !cat.id || cat.mergedInto) return false;
      if (state.zone !== "all" && cat.zone !== state.zone) return false;
      if (!state.showLow && !isHighConfidence(cat)) return false;
      return true;
    });
  }

  // 图片推断候选点：一只猫可能有 1–3 个候选，每个候选单独落点
  var INFER_OFFSETS = {
    "C02:27.4,18.9": [-30, -30],
    "C06:42,24": [-36, -34],
    "C08:15.5,42.5": [-46, -36],
    "C08:70.3,62.8": [-48, 30],
    "C2-01:15.5,42.5": [46, -36],
    "C2-01:70.3,62.8": [48, 30]
  };

  function visibleInferPoints() {
    var points = [];
    if (!state.showInference) return points;
    inferableCats().forEach(function (cat) {
      if (cat.mergedInto || isPlaced(cat)) return;
      cat.inference.candidates.forEach(function (cand) {
        if (state.zone !== "all" && cand.zone !== state.zone) return;
        points.push({ cat: cat, cand: cand, key: cat.id + ":" + cand.x + "," + cand.y });
      });
    });
    return points;
  }

  function visibleSpots() {
    if (!state.showSights) return [];
    return SIGHT_SPOTS.filter(function (spot) {
      return state.zone === "all" || spot.zone === state.zone;
    });
  }

  function pawIcon() {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    [[12, 15.4, 4.6], [6.4, 10.2, 2.1], [10.1, 8, 2.1], [13.9, 8, 2.1], [17.6, 10.2, 2.1]]
      .forEach(function (p) {
        var dot = document.createElementNS(ns, "circle");
        dot.setAttribute("cx", p[0]);
        dot.setAttribute("cy", p[1]);
        dot.setAttribute("r", p[2]);
        dot.setAttribute("fill", "#ffffff");
        svg.appendChild(dot);
      });
    return svg;
  }

  function pctOffset(pct, px) {
    return "calc(" + pct + "% " + (px >= 0 ? "+ " + px : "- " + (-px)) + "px)";
  }

  function buildMarker(cat, point) {
    var cand = point ? point.cand : null;
    var x = cand ? cand.x : cat.x;
    var y = cand ? cand.y : cat.y;
    var offset = cand ? (INFER_OFFSETS[point.key] || [0, -32]) : [Number(cat.dx) || 0, Number(cat.dy) || 0];

    var el = document.createElement("div");
    el.className = "marker" +
      (cand ? " is-infer" : (cat.readerAdded ? " is-reader" : (isHighConfidence(cat) ? "" : " is-low"))) +
      (cat.labelPos === "top" ? " label-top" : "");
    el.dataset.id = cat.id;
    // 同点避让：百分比定位定在真实地点，再用固定像素偏移把徽标分开
    el.style.left = pctOffset(x, offset[0]);
    el.style.top = pctOffset(y, offset[1]);

    var pin = document.createElement("button");
    pin.type = "button";
    pin.className = "pin";
    pin.setAttribute("aria-label", cand
      ? (cat.nickname || "未命名") + "，图片推断候选：" + cand.name +
        "，置信度 " + Math.round(cand.confidence * 100) + "%"
      : (cat.nickname || "未命名") + "，" + (cat.place || "未知地点"));
    pin.appendChild(pawIcon());

    var label = document.createElement("span");
    label.className = "marker-label";
    label.textContent = (cat.nickname || "未命名") +
      (cand ? " · 推断" : (cat.readerAdded ? " · 补充" : ""));

    el.appendChild(pin);
    el.appendChild(label);

    pin.addEventListener("click", function (e) {
      e.stopPropagation();
      openSheet(cat);
    });

    return el;
  }

  function buildHeat(spot) {
    var image = spot.method === "image";
    var el = makeEl("div", "heat" + (image ? " is-infer" : ""));
    el.dataset.id = spot.id;
    el.style.left = pctOffset(spot.x, Number(spot.dx) || 0);
    el.style.top = pctOffset(spot.y, Number(spot.dy) || 0);

    var count = Number(spot.count) || 1;
    var btn = makeEl("button", "heat-btn", String(count));
    btn.type = "button";
    btn.setAttribute("aria-label", spot.name + "，共 " + count + " 条目击" +
      (image ? "（图片推断）" : "（原文地点）"));

    var label = makeEl("span", "heat-label",
      spot.name + " · " + count + " 条" + (image ? " · 推断" : ""));

    el.appendChild(btn);
    el.appendChild(label);

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      openSightSheet(spot);
    });

    return el;
  }

  function render() {
    markersBox.textContent = "";
    sightBox.textContent = "";
    markerEls = {};
    heatEls = {};

    var cats = state.showCats ? visibleCats() : [];
    cats.forEach(function (cat) {
      var el = buildMarker(cat, null);
      markerEls[cat.id] = [el];
      markersBox.appendChild(el);
    });

    var points = visibleInferPoints();
    points.forEach(function (p) {
      var el = buildMarker(p.cat, p);
      if (!markerEls[p.cat.id]) markerEls[p.cat.id] = [];
      markerEls[p.cat.id].push(el);
      markersBox.appendChild(el);
    });

    var spots = visibleSpots();
    spots.forEach(function (spot) {
      var el = buildHeat(spot);
      heatEls[spot.id] = el;
      sightBox.appendChild(el);
    });

    countEl.textContent = (function () {
      var ids = {};
      cats.forEach(function (c) { ids[c.id] = 1; });
      points.forEach(function (p) { ids[p.cat.id] = 1; });
      return Object.keys(ids).length;
    })();
    emptyBox.hidden = cats.length + points.length + spots.length > 0;

    renderEmptyBlocks();
    renderZoneStats();
    highlight(state.selectedId);
    scheduleLabelCollision();
    renderStats();
  }

  function highlight(id) {
    Object.keys(markerEls).forEach(function (key) {
      var list = Array.isArray(markerEls[key]) ? markerEls[key] : [markerEls[key]];
      list.forEach(function (el) { el.classList.toggle("is-active", key === id); });
    });
    scheduleLabelCollision();
  }

  /* ---------- 空白区块覆盖层 ---------- */
  function renderEmptyBlocks() {
    emptyBlockBox.textContent = "";
    EMPTY_BLOCKS.forEach(function (b) {
      var el = makeEl("button", "empty-block");
      el.type = "button";
      el.style.left = b.x + "%";
      el.style.top = b.y + "%";
      el.style.width = b.w + "%";
      el.style.height = b.h + "%";
      el.title = (b.name || "") + "：" + (b.note || "暂无信息");
      el.setAttribute("aria-label", (b.name || "空白片区") + "，暂无信息，点击查看缺什么");

      el.appendChild(makeEl("span", "empty-badge", "待补充"));

      var lab = makeEl("div", "empty-label");
      lab.appendChild(makeEl("b", null, "暂无信息"));
      lab.appendChild(makeEl("span", null, b.name));
      el.appendChild(lab);
      el.addEventListener("click", function () { openEmptySheet(b); });
      emptyBlockBox.appendChild(el);
    });
  }

  /* ---------- 区域统计 ---------- */
  function zoneInfo(zone) {
    var sights = SIGHT_SPOTS.filter(function (s) { return s.zone === zone; })
      .reduce(function (sum, s) { return sum + (Number(s.count) || 1); }, 0);
    var cats = CATS.filter(function (c) {
      return !c.mergedInto && !c.readerAdded && isPlaced(c) && c.zone === zone;
    }).length;
    var reader = CATS.filter(function (c) {
      return !c.mergedInto && c.readerAdded && c.zone === zone;
    }).length;
    var infer = inferableCats().filter(function (c) {
      return !c.mergedInto && c.inference.candidates.some(function (cand) { return cand.zone === zone; });
    }).length;
    return {
      zone: zone, sights: sights, cats: cats, reader: reader, infer: infer,
      total: sights + cats + reader + infer
    };
  }

  function renderZoneStats() {
    var box = document.getElementById("zoneStats");
    box.textContent = "";

    var infos = ZONE_ORDER.slice(1).map(zoneInfo);
    var max = Math.max.apply(null, infos.map(function (i) { return i.total; }));

    infos.forEach(function (info) {
      var empty = info.total === 0;
      var row = makeEl("button", "zrow" + (empty ? " is-empty" : ""));
      row.type = "button";
      var active = info.zone === state.zone;
      row.classList.toggle("is-selected", active);
      row.setAttribute("aria-pressed", active ? "true" : "false");

      var name = makeEl("span", "zname", ZONES[info.zone]);
      var status = makeEl("span", "zstatus" + (!empty && info.total === max ? " is-max" : ""),
        empty ? "空白" : (info.total === max ? "信息最多" : "信息较少"));
      var bar = makeEl("span", "zbar");
      var fill = document.createElement("i");
      fill.style.width = (max > 0 ? Math.round(info.total / max * 100) : 0) + "%";
      bar.appendChild(fill);

      var counts = makeEl("span", "zcounts",
        "目击 " + info.sights + " 条 · 具名猫 " + info.cats + " 只" +
        (info.infer ? " · 推断 " + info.infer + " 只" : "") +
        (info.reader ? " · 读者补充 " + info.reader + " 只" : ""));

      row.appendChild(name);
      row.appendChild(status);
      row.appendChild(bar);
      row.appendChild(counts);
      row.addEventListener("click", function () { setZone(info.zone); });
      box.appendChild(row);
    });

    document.getElementById("zoneNote").textContent =
      "另有 " + (stats.sightingNoCue || 0) +
      " 条目击正文与配图都没有可判读地点，未计入区域统计；地图上斜纹区块表示该片区目前没有任何点位。";
  }

  /* ---------- 详情卡 ---------- */
  function makeEl(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }

  function zoneLabel(zone) {
    return ZONES[zone] || "其他";
  }

  function confidenceWord(conf) {
    if (conf >= 0.8) return "较高";
    if (conf >= LOW) return "中等";
    return "较低";
  }

  function buildPhoto(cat) {
    var box = makeEl("div", "photo");

    function placeholder() {
      box.textContent = "";
      var wrap = makeEl("div", "photo-empty");
      var ns = "http://www.w3.org/2000/svg";
      var svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", "0 0 160 100");
      svg.setAttribute("aria-hidden", "true");

      var shapes = [
        ["ellipse", { cx: 80, cy: 86, rx: 46, ry: 14 }],
        ["circle", { cx: 80, cy: 52, r: 27 }],
        ["path", { d: "M56 34 L50 12 L74 26 Z" }],
        ["path", { d: "M104 34 L110 12 L86 26 Z" }]
      ];
      var g1 = document.createElementNS(ns, "g");
      g1.setAttribute("fill", "#b9c8bc");
      shapes.forEach(function (s) {
        var node = document.createElementNS(ns, s[0]);
        Object.keys(s[1]).forEach(function (k) { node.setAttribute(k, s[1][k]); });
        g1.appendChild(node);
      });

      var g2 = document.createElementNS(ns, "g");
      g2.setAttribute("fill", "#f7f4ee");
      [[70, 52, 3.4], [90, 52, 3.4]].forEach(function (p) {
        var eye = document.createElementNS(ns, "circle");
        eye.setAttribute("cx", p[0]);
        eye.setAttribute("cy", p[1]);
        eye.setAttribute("r", p[2]);
        g2.appendChild(eye);
      });

      svg.appendChild(g1);
      svg.appendChild(g2);
      wrap.appendChild(svg);
      wrap.appendChild(makeEl("span", null, "原文未附图"));
      box.appendChild(wrap);
    }

    var photoSrc = cat.photo || null;
    if (photoSrc && !/^(assets\/|data:image\/|https?:\/\/)/.test(photoSrc)) photoSrc = null;
    if (photoSrc) {
      var img = makeEl("img");
      img.src = photoSrc;
      img.alt = (cat.nickname || "猫") + " 的照片";
      img.loading = "lazy";
      img.decoding = "async";
      img.onerror = placeholder;
      box.appendChild(img);
    } else {
      placeholder();
    }

    return box;
  }

  function buildInferenceBox(cat) {
    var inf = cat.inference;
    if (!inf) return null;

    var box = makeEl("div", "infer-box");

    if (inferable(cat)) {
      box.appendChild(makeEl("b", null, "图片推断 · 依据可判读的环境线索"));
      if (inf.cues && inf.cues.length) {
        box.appendChild(makeEl("span", null, "线索：" + inf.cues.join("；")));
      }
      inf.candidates.forEach(function (cand) {
        var line = makeEl("span", "infer-cand");
        line.appendChild(makeEl("em", null, cand.name));
        line.appendChild(document.createTextNode(
          " · " + Math.round(cand.confidence * 100) + "% · " + cand.cue));
        box.appendChild(line);
      });
      box.appendChild(makeEl("span", null,
        "推断值 " + Math.round((inf.confidence || 0) * 100) +
        "%，只作为候选，未经证实；置信度体系仍按已核实/推断分列。"));
      return box;
    }

    if (inf.noCue) {
      box.appendChild(makeEl("b", null, "图片无可判读线索"));
      box.appendChild(makeEl("span", null,
        inf.note || "配图中没有楼牌、建筑或设施特征，保持未落点，不做猜测。"));
      if (inf.cues && inf.cues.length) {
        box.appendChild(makeEl("span", null, "已检查：" + inf.cues.join("；")));
      }
      return box;
    }

    return null;
  }

  function buildSlots(cat) {
    var rows = [
      { label: "地点", value: cat.place || "待补充", missing: !cat.place },
      { label: "活跃时段", value: cat.activeTime || "未记录", missing: !cat.activeTime },
      { label: "外观", value: cat.appearance || "仅文字描述 / 无", missing: !cat.appearance },
      { label: "状态", value: cat.status || "暂无", missing: !cat.status }
    ];
    if (cat.readerMiss && !cat.place) {
      rows[0].value = "待补充（读者填「" + cat.readerMiss.raw + "」未匹配）";
      rows[0].missing = true;
    }

    var grid = makeEl("div", "slots");
    rows.forEach(function (r) {
      var slot = makeEl("div", "slot" + (r.missing ? " is-missing" : ""));
      slot.appendChild(makeEl("span", "slot-label", r.label));
      var value = makeEl("span", "slot-value", r.value);
      if (r.missing) value.appendChild(makeEl("span", "slot-chip", "等人填"));
      slot.appendChild(value);
      grid.appendChild(slot);
    });
    return grid;
  }

  function buildEditBox(cat) {
    var box = makeEl("div", "edit-box");
    box.appendChild(makeEl("h4", null, "补充这条记录"));
    box.appendChild(makeEl("p", "report-tip",
      "地点必填，提交后会先匹配地标（楼号 / 五谷堂 / 榕园 / 东门 / 柳湖等）；匹配成功立即落点，标为「读者补充，未核实」。填写只写入本机 localStorage，刷新不丢；如果本机存储不可用，只在本次会话有效，刷新后可能丢失。"));

    function field(labelText, node) {
      var f = makeEl("label", "field");
      f.appendChild(document.createTextNode(labelText));
      f.appendChild(node);
      return f;
    }

    var place = makeEl("input");
    place.type = "text";
    place.placeholder = "例如：竹园 3 栋楼下 / 五谷堂后门 / 柳湖东岸";
    place.autocomplete = "off";

    var alias = makeEl("input");
    alias.type = "text";
    alias.placeholder = "可填另一只猫的名字，或留空";
    alias.autocomplete = "off";

    var note = makeEl("textarea");
    note.placeholder = "什么时候看到的、外观、和谁在一起……";

    var sawWrap = makeEl("label", "saw");
    var saw = makeEl("input");
    saw.type = "checkbox";
    sawWrap.appendChild(saw);
    sawWrap.appendChild(document.createTextNode(" 我亲眼见过"));

    var actions = makeEl("div", "report-actions");
    var submit = makeEl("button", "supp-btn", "提交到待合并队列");
    submit.type = "button";
    var tip = makeEl("p", "report-tip");

    box.appendChild(field("地点（必填）", place));
    box.appendChild(field("别名 / 我知道它其实就是谁（选填）", alias));
    box.appendChild(field("补充说明（选填）", note));
    box.appendChild(sawWrap);
    actions.appendChild(submit);
    box.appendChild(actions);
    box.appendChild(tip);

    submit.addEventListener("click", function () {
      submitReaderForm(cat, { place: place, alias: alias, note: note, saw: saw }, tip);
    });

    return box;
  }

  function buildSheet(cat) {
    sheet.textContent = "";

    if (cat.readerAdded) {
      sheet.appendChild(makeEl("div", "infer-banner reader-banner", "读者补充，未核实"));
    } else if (cat.mergedFrom && cat.mergedFrom.length) {
      sheet.appendChild(makeEl("div", "infer-banner merge-banner", "已合并记录"));
    } else if (inferable(cat)) {
      sheet.appendChild(makeEl("div", "infer-banner", "图片推断，未经证实"));
    }

    var head = makeEl("div", "sheet-head");
    var tags = makeEl("div", "badges");
    if (cat.zone) tags.appendChild(makeEl("span", "tag", zoneLabel(cat.zone)));
    if (!isPlaced(cat)) tags.appendChild(makeEl("span", "tag tag-sample", "未落点"));
    if (cat.readerAdded) tags.appendChild(makeEl("span", "tag tag-reader", "读者补充"));
    if (inferable(cat)) tags.appendChild(makeEl("span", "tag tag-infer", "图片推断候选"));
    if (cat.status) tags.appendChild(makeEl("span", "tag status-tag", cat.status));
    var close = makeEl("button", "close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "关闭详情");
    close.addEventListener("click", closeSheet);
    head.appendChild(tags);
    head.appendChild(close);

    sheet.appendChild(head);
    sheet.appendChild(buildPhoto(cat));

    var body = makeEl("div", "sheet-body");

    var name = makeEl("h2", "cat-name", cat.nickname || "未命名");
    name.id = "catName";
    body.appendChild(name);

    if (cat.aliases && cat.aliases.length) {
      body.appendChild(makeEl("p", "cat-alias", "别名：" + cat.aliases.join("、")));
    }

    var place = makeEl("p", "cat-place");
    var ns = "http://www.w3.org/2000/svg";
    var pinIcon = document.createElementNS(ns, "svg");
    pinIcon.setAttribute("viewBox", "0 0 24 24");
    var path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "#9aa199");
    path.setAttribute("stroke-width", "1.8");
    pinIcon.appendChild(path);
    place.appendChild(pinIcon);
    place.appendChild(document.createTextNode(
      cat.place || (isPlaced(cat) ? "未知地点" : "未落点 · 原文没写可定位的位置")));
    body.appendChild(place);

    if (!isPlaced(cat)) {
      body.appendChild(buildSlots(cat));
      if (cat.readerMiss) {
        body.appendChild(makeEl("p", "report-tip",
          "读者填写的地点「" + cat.readerMiss.raw + "」未匹配到地标：需要更具体的位置，如楼栋 + 方位（例：竹园 3 栋楼下）。"));
      }
    }

    var inferBox = buildInferenceBox(cat);
    if (inferBox) body.appendChild(inferBox);

    var conf = typeof cat.confidence === "number" ? cat.confidence : null;
    var confBox = makeEl("div", "conf" + (conf !== null && conf < LOW ? " is-low" : ""));
    var confTop = makeEl("div", "conf-top");
    confTop.appendChild(makeEl("span", null, conf !== null ? "置信度 · " + confidenceWord(conf) : "置信度 · 未落点"));
    confTop.appendChild(makeEl("b", null, conf !== null ? Math.round(conf * 100) + "%" : "—"));
    if (conf !== null) {
      var bar = makeEl("div", "bar");
      var fill = document.createElement("i");
      fill.style.width = Math.max(0, Math.min(100, conf * 100)) + "%";
      bar.appendChild(fill);
      confBox.appendChild(confTop);
      confBox.appendChild(bar);
    } else {
      confBox.appendChild(confTop);
    }
    body.appendChild(confBox);

    var facts = makeEl("dl", "facts");
    var factRows = isPlaced(cat) ? [
      ["外观特征", cat.appearance || "原文未提及"],
      ["活跃时段", cat.activeTime || "原文未提及"],
      ["状态", cat.status],
      ["喂食提示", cat.feedNote],
      ["数据批次", cat.batch === "first-pass" ? "第一遍采集（帖 1–50）" : "第二遍采集（帖 51–111）"],
      ["备注", cat.note],
    ] : [
      ["喂食提示", cat.feedNote],
      ["数据批次", cat.batch === "first-pass" ? "第一遍采集（帖 1–50）" : "第二遍采集（帖 51–111）"],
      ["备注", cat.note],
    ];
    factRows.forEach(function (row) {
      if (!row[1]) return;
      var item = document.createElement("div");
      item.appendChild(makeEl("dt", null, row[0]));
      item.appendChild(makeEl("dd", null, row[1]));
      facts.appendChild(item);
    });
    body.appendChild(facts);

    if (cat.related && cat.related.length) {
      var relBox = makeEl("div", "rel");
      relBox.appendChild(makeEl("b", null, "疑似同一只（仅提示，未合并）"));
      cat.related.forEach(function (r) {
        var line = makeEl("span", "rel-line");
        line.appendChild(document.createTextNode("↔ "));
        var other = catById(r.catId);
        if (other) {
          var link = makeEl("button", "rel-link", r.name);
          link.type = "button";
          link.addEventListener("click", function () { openSheet(other); });
          line.appendChild(link);
        } else {
          line.appendChild(document.createTextNode(r.name));
        }
        line.appendChild(document.createTextNode(
          " · " + Math.round(r.similarity * 100) + "% · " + r.note));
        relBox.appendChild(line);
      });
      body.appendChild(relBox);
    }

    if (cat.mergedFrom && cat.mergedFrom.length) {
      var mergedBox = makeEl("div", "rel");
      mergedBox.appendChild(makeEl("b", null, "已合并自"));
      cat.mergedFrom.forEach(function (f) {
        var line = makeEl("span", "rel-line");
        line.appendChild(document.createTextNode("← " + f.nickname +
          (f.sourcePost ? "（" + f.sourcePost + "）" : "")));
        if (f.sourceUrl) {
          var a = makeEl("a", "mini-link", "原帖");
          a.href = f.sourceUrl;
          a.target = "_blank";
          a.rel = "noreferrer";
          a.style.marginLeft = "5px";
          line.appendChild(a);
        }
        mergedBox.appendChild(line);
      });
      mergedBox.appendChild(makeEl("span", "rel-line",
        "合并为同一只：别名已并入，代表图保留主记录的照片；可从「待确认合并」撤销。"));
      body.appendChild(mergedBox);
    }

    if (cat.quote) {
      var quote = makeEl("div", "source");
      quote.appendChild(makeEl("b", null, "原文摘录"));
      quote.appendChild(document.createTextNode(cat.quote));
      body.appendChild(quote);
    }

    if (cat.sourcePost || cat.sourceUrl) {
      var source = makeEl("div", "source");
      source.appendChild(makeEl("b", null, "来源帖子"));
      source.appendChild(document.createTextNode(cat.sourcePost || "读者补充"));
      if (cat.sourceUrl) {
        var sourceLink = makeEl("a", "mini-link", "打开原文");
        sourceLink.href = cat.sourceUrl;
        sourceLink.target = "_blank";
        sourceLink.rel = "noreferrer";
        sourceLink.style.marginLeft = "6px";
        source.appendChild(sourceLink);
      }
      body.appendChild(source);
    }

    var historyBox = buildHistoryBox(cat);
    if (historyBox) body.appendChild(historyBox);

    body.appendChild(buildSuppRow({ type: "cat", cat: cat }));
    if (!cat.mergedInto) body.appendChild(buildEditBox(cat));

    sheet.appendChild(body);
  }

  function buildSuppRow(ctx) {
    var row = makeEl("div", "supp-row");
    var copy = makeEl("button", "supp-btn", "复制补充文本");
    copy.type = "button";
    copy.addEventListener("click", function () { copySupplement(ctx, copy); });
    var json = makeEl("button", "supp-btn ghost", "下载补丁 JSON");
    json.type = "button";
    json.addEventListener("click", downloadPatch);
    row.appendChild(copy);
    row.appendChild(json);
    return row;
  }

  function openEmptySheet(block) {
    sheet.dataset.mode = "detail";
    sheet.classList.remove("contribute");
    sheet.textContent = "";

    var head = makeEl("div", "sheet-head");
    var tags = makeEl("div", "badges");
    tags.appendChild(makeEl("span", "tag tag-sample", "暂无信息"));
    tags.appendChild(makeEl("span", "tag", "待补充区块"));
    var close = makeEl("button", "close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "关闭空白区块说明");
    close.addEventListener("click", closeSheet);
    head.appendChild(tags);
    head.appendChild(close);
    sheet.appendChild(head);

    var body = makeEl("div", "sheet-body");
    var title = makeEl("h2", "cat-name", block.name);
    title.id = "catName";
    body.appendChild(title);

    body.appendChild(makeEl("p", "cat-place",
      block.note || "该片区目前没有任何已核实点位或可落点的目击点。"));

    var ask = makeEl("div", "ask");
    ask.appendChild(makeEl("b", null, "知道它常在哪出没？"));
    ask.appendChild(document.createTextNode("去频道帖子下面留一句就行。"));
    ask.appendChild(makeEl("span", null,
      "写清猫名 + 楼栋方位，比如：朵朵在五谷堂后门的水泥台——只写「我知道」没法落点；看到会补进下一版。"));
    body.appendChild(ask);

    var box = makeEl("div", "infer-box");
    box.appendChild(makeEl("b", null, "这里缺什么"));
    ["具名猫的地点（卡面上标为「待补充」）",
      "猫的活跃时段（标为「未记录」）",
      "可辨认的外观描述或照片",
      "该片区的目击记录"].forEach(function (t) {
      box.appendChild(makeEl("span", "infer-cand", t));
    });
    box.appendChild(makeEl("span", null,
      "这不是错误，而是数据空白：地图不会为了好看去填猜测点位。"));
    body.appendChild(box);

    body.appendChild(makeEl("p", "report-tip",
      "如果知道这里的猫，可打开对应卡片填写，或复制补充文本、下载补丁 JSON 交给维护者。"));

    sheet.appendChild(body);
    backdrop.hidden = false;
    sheet.hidden = false;
    sheet.scrollTop = 0;
    close.focus();
  }

  function openSightSheet(spot) {
    sheet.dataset.mode = "detail";
    sheet.classList.remove("contribute");
    sheet.textContent = "";

    if (spot.method === "image") {
      sheet.appendChild(makeEl("div", "infer-banner", "图片推断，未经证实"));
    }

    var head = makeEl("div", "sheet-head");
    var tags = makeEl("div", "badges");
    tags.appendChild(makeEl("span", "tag tag-heat", "目击点"));
    tags.appendChild(makeEl("span", "tag tag-sample", "未归属目击"));
    if (spot.zone) tags.appendChild(makeEl("span", "tag", zoneLabel(spot.zone)));
    if (Number(spot.confidence) <= 0.5) tags.appendChild(makeEl("span", "tag zone-level", "区域级"));
    var close = makeEl("button", "close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "关闭目击点详情");
    close.addEventListener("click", closeSheet);
    head.appendChild(tags);
    head.appendChild(close);
    sheet.appendChild(head);

    var body = makeEl("div", "sheet-body");
    var name = makeEl("h2", "cat-name", spot.name);
    name.id = "catName";
    body.appendChild(name);

    var place = makeEl("p", "cat-place");
    var ns = "http://www.w3.org/2000/svg";
    var icon = document.createElementNS(ns, "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    var path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "#9aa199");
    path.setAttribute("stroke-width", "1.8");
    icon.appendChild(path);
    place.appendChild(icon);
    place.appendChild(document.createTextNode(spot.place || spot.placeRaw || "原文未写具体地点"));
    body.appendChild(place);

    var entries = Array.isArray(spot.entries) ? spot.entries : [];
    var times = [];
    entries.forEach(function (en) {
      if (en.time && times.indexOf(en.time) < 0) times.push(en.time);
    });

    var facts = makeEl("dl", "facts");
    [
      ["时间", times.length ? times.join(" / ") : "原文未记"],
      ["条数", (Number(spot.count) || entries.length) + " 条目击合并在此点"],
      ["地点原文", spot.placeRaw || "—"],
      ["定位依据", spot.method === "image" ? "配图环境线索（推断）" : "正文地点文字"],
      ["及时性", "原始帖按采集顺序，不代表实时出没"]
    ].forEach(function (row) {
      if (!row[1]) return;
      var item = document.createElement("div");
      item.appendChild(makeEl("dt", null, row[0]));
      item.appendChild(makeEl("dd", null, row[1]));
      facts.appendChild(item);
    });
    body.appendChild(facts);

    // 配图缩略图：有图才显示，最多 6 张
    var photos = [];
    entries.forEach(function (en) {
      (en.photos || []).forEach(function (p) {
        if (photos.indexOf(p) < 0) photos.push(p);
      });
    });
    if (photos.length) {
      var strip = makeEl("div", "sight-photos");
      photos.slice(0, 6).forEach(function (src) {
        var img = makeEl("img");
        img.src = src;
        img.alt = "目击配图";
        img.loading = "lazy";
        strip.appendChild(img);
      });
      body.appendChild(strip);
    }

    if (entries.length) {
      var listTitle = makeEl("b", null, "帖子记录");
      listTitle.style.cssText = "display:block;margin-top:14px;font-size:11.5px;color:#9aa199;";
      body.appendChild(listTitle);
      entries.forEach(function (en) {
        var row = makeEl("div", "sight-entry");
        row.appendChild(makeEl("b", null, en.quote || en.title || "（原文无正文）"));
        row.appendChild(makeEl("i", null,
          " · " + (en.time || "日期未记") + " · 帖 #" + en.listIndex +
          " · " + (en.photoCount || 0) + " 图"));
        if (en.sourceUrl) {
          var a = makeEl("a", "mini-link", "查看原帖");
          a.href = en.sourceUrl;
          a.target = "_blank";
          a.rel = "noreferrer";
          a.style.marginLeft = "6px";
          row.appendChild(a);
        }
        body.appendChild(row);
      });
    }

    if (spot.method === "image") {
      var box = makeEl("div", "infer-box");
      box.appendChild(makeEl("b", null, "图片推断依据"));
      if (spot.cues && spot.cues.length) {
        box.appendChild(makeEl("span", null, spot.cues.join("；")));
      }
      box.appendChild(makeEl("span", null,
        "置信度 " + Math.round((spot.confidence || 0) * 100) + "%：仅表示“配图环境与该校区的某片区域相符”，不是确认位置。"));
      body.appendChild(box);
    }

    if (spot.note) {
      var note = makeEl("div", "source");
      note.appendChild(makeEl("b", null, "备注"));
      note.appendChild(document.createTextNode(spot.note));
      body.appendChild(note);
    }

    if (spot.sourceUrl) {
      var source = makeEl("p", "report-tip");
      var a2 = makeEl("a", "mini-link", "打开该目击原帖");
      a2.href = spot.sourceUrl;
      a2.target = "_blank";
      a2.rel = "noreferrer";
      source.appendChild(a2);
      body.appendChild(source);
    }

    body.appendChild(buildSuppRow({ type: "spot", spot: spot }));

    sheet.appendChild(body);

    backdrop.hidden = false;
    sheet.hidden = false;
    sheet.scrollTop = 0;
    var closeBtn = sheet.querySelector(".close");
    if (closeBtn) closeBtn.focus();
  }

  function openSheet(cat) {
    sheet.dataset.mode = "detail";
    sheet.classList.remove("contribute");
    buildSheet(cat);
    state.selectedId = cat.id;
    highlight(cat.id);

    backdrop.hidden = false;
    sheet.hidden = false;
    sheet.scrollTop = 0;

    var closeBtn = sheet.querySelector(".close");
    if (closeBtn) closeBtn.focus();
  }

  function closeSheet() {
    var wasContrib = sheet.dataset.mode === "contribute";
    backdrop.hidden = true;
    sheet.hidden = true;
    state.selectedId = null;
    highlight(null);
    if (wasContrib) {
      resetContribState();
      sheet.dataset.mode = "";
      sheet.classList.remove("contribute");
    } else {
      stopPickMode(false);
    }
  }

  /* ---------- 读者线索提交 ---------- */
  function resetContribState() {
    stopPickMode(false);
    clearContribDraft();
    contrib.zone = "";
    contrib.photoName = "";
    if (contrib.photoUrl) {
      URL.revokeObjectURL(contrib.photoUrl);
      contrib.photoUrl = "";
    }
    contrib.geoBusy = false;
  }

  function updateContribLocation() {
    var el = document.getElementById("contribLoc");
    if (!el) return;
    if (contrib.x == null || contrib.y == null) {
      el.className = "contrib-loc is-empty";
      el.textContent = "尚未选点。请点“在地图上选点”标记猫咪位置。";
      return;
    }
    el.className = "contrib-loc is-set";
    el.textContent = "已选点：x " + contrib.x.toFixed(1) + "%，y " + contrib.y.toFixed(1) + "%（示意地图百分比，会写入 Issue）";
  }

  function setContribStatus(text, type) {
    var el = document.getElementById("contribStatus");
    if (!el) return;
    el.className = "contrib-status" + (type ? " is-" + type : "");
    el.textContent = text || "";
  }

  function geoToMap(lat, lng) {
    var marginLat = (CAMPUS_GEO.north - CAMPUS_GEO.south) * 0.2;
    var marginLng = (CAMPUS_GEO.east - CAMPUS_GEO.west) * 0.2;
    if (lat < CAMPUS_GEO.south - marginLat || lat > CAMPUS_GEO.north + marginLat ||
        lng < CAMPUS_GEO.west - marginLng || lng > CAMPUS_GEO.east + marginLng) {
      return null;
    }
    var x = MAP_BOUNDS.left + (lng - CAMPUS_GEO.west) / (CAMPUS_GEO.east - CAMPUS_GEO.west) * (MAP_BOUNDS.right - MAP_BOUNDS.left);
    var y = MAP_BOUNDS.top + (CAMPUS_GEO.north - lat) / (CAMPUS_GEO.north - CAMPUS_GEO.south) * (MAP_BOUNDS.bottom - MAP_BOUNDS.top);
    return { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) };
  }

  function nearestZone(x, y) {
    var best = "other";
    var bestD = Infinity;
    Object.keys(ZONE_ANCHORS).forEach(function (zone) {
      ZONE_ANCHORS[zone].forEach(function (p) {
        var d = Math.hypot(x - p[0], y - p[1]);
        if (d < bestD) { bestD = d; best = zone; }
      });
    });
    return bestD <= 24 ? best : "other";
  }

  function suggestZoneByGeo() {
    var btn = document.getElementById("contribGeo");
    if (!navigator.geolocation) {
      setContribStatus("当前浏览器不支持定位，请直接在地图上选点。", "error");
      return;
    }
    if (contrib.geoBusy) return;
    contrib.geoBusy = true;
    if (btn) btn.disabled = true;
    setContribStatus("正在获取大致位置…");
    navigator.geolocation.getCurrentPosition(function (pos) {
      contrib.geoBusy = false;
      if (btn) btn.disabled = false;
      var p = geoToMap(pos.coords.latitude, pos.coords.longitude);
      if (!p) {
        setContribStatus("你似乎不在柳林校区范围内。仍可在地图上手动选点。", "error");
        return;
      }
      var zone = nearestZone(p.x, p.y);
      contrib.zone = zone;
      var sel = document.getElementById("contribZone");
      if (sel) sel.value = zone;
      setContribStatus("定位显示你可能在「" + zoneLabel(zone) + "」附近。请点“在地图上选点”确认具体位置；定位只用于推荐区域，不会写入提交。", "ok");
    }, function (err) {
      contrib.geoBusy = false;
      if (btn) btn.disabled = false;
      var msg = err.code === 1 ? "定位权限被拒绝，请直接在地图上选点。"
        : err.code === 3 ? "定位超时，请重试或直接在地图上选点。"
        : "无法获取定位，请直接在地图上选点。";
      setContribStatus(msg, "error");
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  }

  function contribField(labelText, node, required) {
    var label = makeEl("label", "field");
    label.appendChild(document.createTextNode(labelText + " "));
    if (required) label.appendChild(makeEl("em", null, "*"));
    label.appendChild(node);
    return label;
  }

  function openContributeSheet() {
    resetContribState();
    sheet.dataset.mode = "contribute";
    sheet.classList.add("contribute");
    sheet.textContent = "";

    var head = makeEl("div", "sheet-head");
    var titleWrap = makeEl("div", "contrib-head");
    titleWrap.appendChild(makeEl("h2", "contrib-title", "提供猫咪线索"));
    titleWrap.appendChild(makeEl("p", "contrib-sub", "通过 GitHub Issue 提交最新目击"));
    head.appendChild(titleWrap);
    var close = makeEl("button", "close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "关闭线索提交");
    close.addEventListener("click", closeSheet);
    head.appendChild(close);
    sheet.appendChild(head);

    var body = makeEl("div", "sheet-body");
    body.appendChild(makeEl("p", "contrib-intro", "提交后会打开一条预填的 GitHub Issue，需要 GitHub 账号；内容会公开。定位只用于推荐区域，不会保存原始 GPS。"));
    var grid = makeEl("div", "contrib-grid");

    var name = document.createElement("input");
    name.type = "text";
    name.id = "contribName";
    name.maxLength = 40;
    name.placeholder = "例如：午午 / 新出现的小橘";

    var zone = document.createElement("select");
    zone.id = "contribZone";
    zone.appendChild(new Option("请选择区域", ""));
    ZONE_ORDER.slice(1).forEach(function (key) {
      zone.appendChild(new Option(ZONES[key], key));
    });
    zone.addEventListener("change", function () { contrib.zone = zone.value; });

    var place = document.createElement("input");
    place.type = "text";
    place.id = "contribPlace";
    place.maxLength = 80;
    place.placeholder = "例如：榕园 40 号楼东侧投喂点";

    var time = document.createElement("input");
    time.type = "datetime-local";
    time.id = "contribTime";

    grid.appendChild(contribField("猫名 / 临时称呼", name, true));
    grid.appendChild(contribField("区域", zone, true));
    grid.appendChild(contribField("地点描述", place, false));
    grid.appendChild(contribField("目击时间", time, false));
    body.appendChild(grid);

    var notes = document.createElement("textarea");
    notes.id = "contribNotes";
    notes.maxLength = 500;
    notes.placeholder = "外观、行为、是否亲人、和哪只猫一起出现…";
    body.appendChild(contribField("外观 / 备注", notes, false));

    var contact = document.createElement("input");
    contact.type = "text";
    contact.id = "contribContact";
    contact.maxLength = 80;
    contact.placeholder = "可选；会公开在 Issue 里";
    body.appendChild(contribField("联系方式（可选，会公开）", contact, false));

    var photo = document.createElement("input");
    photo.type = "file";
    photo.id = "contribPhoto";
    photo.accept = "image/*";
    body.appendChild(contribField("照片（可选）", photo, false));

    var photoWrap = makeEl("div", "contrib-photo");
    var photoPrev = makeEl("img");
    photoPrev.id = "contribPreview";
    photoPrev.alt = "猫咪照片预览";
    var photoNote = makeEl("small", null, "照片无法通过链接上传；打开 Issue 后请把照片拖入编辑框。");
    photoWrap.appendChild(photoPrev);
    photoWrap.appendChild(photoNote);
    body.appendChild(photoWrap);

    photo.addEventListener("change", function () {
      var file = photo.files && photo.files[0];
      if (contrib.photoUrl) {
        URL.revokeObjectURL(contrib.photoUrl);
        contrib.photoUrl = "";
      }
      if (!file) {
        contrib.photoName = "";
        photoPrev.removeAttribute("src");
        photoPrev.classList.remove("is-on");
        photoNote.textContent = "照片无法通过链接上传；打开 Issue 后请把照片拖入编辑框。";
        return;
      }
      contrib.photoName = file.name;
      contrib.photoUrl = URL.createObjectURL(file);
      photoPrev.src = contrib.photoUrl;
      photoPrev.classList.add("is-on");
      photoNote.textContent = "已选择：" + file.name + "（打开 Issue 后请把照片拖入编辑框）";
    });

    body.appendChild(makeEl("div", "contrib-section-title", "位置"));
    body.appendChild(makeEl("p", "contrib-hint", "先在示意地图上选点；提交时会把坐标写入 Issue。"));
    var tools = makeEl("div", "contrib-tools");
    var pick = makeEl("button", "supp-btn", "在地图上选点");
    pick.type = "button";
    pick.id = "contribPick";
    pick.addEventListener("click", enterPickMode);
    var geo = makeEl("button", "supp-btn ghost", "使用我的定位");
    geo.type = "button";
    geo.id = "contribGeo";
    geo.addEventListener("click", suggestZoneByGeo);
    tools.appendChild(pick);
    tools.appendChild(geo);
    body.appendChild(tools);

    var loc = makeEl("div", "contrib-loc is-empty");
    loc.id = "contribLoc";
    loc.textContent = "尚未选点。请点“在地图上选点”标记猫咪位置。";
    body.appendChild(loc);

    var status = makeEl("p", "contrib-status");
    status.id = "contribStatus";
    status.setAttribute("aria-live", "polite");
    body.appendChild(status);

    var consent = document.createElement("input");
    consent.type = "checkbox";
    consent.id = "contribConsent";
    var consentLabel = makeEl("label", "contrib-consent");
    consentLabel.appendChild(consent);
    consentLabel.appendChild(document.createTextNode("我确认以上内容会公开在 GitHub Issue 上，且不包含精确 GPS 坐标。"));
    body.appendChild(consentLabel);

    var actions = makeEl("div", "contrib-actions");
    var submit = makeEl("button", "export-btn", "在 GitHub 打开并提交");
    submit.type = "button";
    submit.id = "contribSubmit";
    submit.addEventListener("click", submitContribution);
    var copy = makeEl("button", "ghost-btn", "复制内容");
    copy.type = "button";
    copy.id = "contribCopy";
    copy.addEventListener("click", copyContribution);
    var cancel = makeEl("button", "ghost-btn", "取消");
    cancel.type = "button";
    cancel.addEventListener("click", closeSheet);
    actions.appendChild(submit);
    actions.appendChild(copy);
    actions.appendChild(cancel);
    body.appendChild(actions);
    body.appendChild(makeEl("p", "contrib-hint", "提交会打开新标签页；若被浏览器拦截，请用“复制内容”。照片请在 Issue 编辑框里拖入。"));

    sheet.appendChild(body);
    sheet.hidden = false;
    backdrop.hidden = false;
    sheet.scrollTop = 0;
    updateContribLocation();
    name.focus();
  }

  function placeContribDraft(x, y) {
    contrib.x = x;
    contrib.y = y;
    draftMarker.hidden = false;
    draftMarker.style.left = x + "%";
    draftMarker.style.top = y + "%";
  }

  function clearContribDraft() {
    contrib.x = null;
    contrib.y = null;
    draftMarker.hidden = true;
    updateContribLocation();
  }

  function stopPickMode(reopen) {
    contrib.picking = false;
    contrib.pickReady = false;
    stage.classList.remove("is-picking");
    stage.removeEventListener("click", handleMapPick, true);
    pickBanner.hidden = true;
    if (reopen && sheet.dataset.mode === "contribute") {
      sheet.hidden = false;
      backdrop.hidden = false;
      updateContribLocation();
    }
  }

  function enterPickMode() {
    if (contrib.picking) return;
    contrib.picking = true;
    contrib.pickReady = false;
    sheet.hidden = true;
    backdrop.hidden = true;
    pickBanner.hidden = false;
    stage.classList.add("is-picking");
    setZone("all");
    stage.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
    stage.addEventListener("click", handleMapPick, true);
    setTimeout(function () {
      if (contrib.picking) contrib.pickReady = true;
    }, prefersReducedMotion() ? 0 : 450);
  }

  function handleMapPick(e) {
    if (!contrib.picking) return;
    if (e.target.closest("#pickBanner")) return;
    e.preventDefault();
    e.stopPropagation();
    if (!contrib.pickReady) return;
    var rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var x = Math.max(0, Math.min(100, (e.clientX - rect.left) / rect.width * 100));
    var y = Math.max(0, Math.min(100, (e.clientY - rect.top) / rect.height * 100));
    placeContribDraft(x, y);
    var zone = nearestZone(x, y);
    contrib.zone = zone;
    stopPickMode(true);
    var sel = document.getElementById("contribZone");
    if (sel) sel.value = zone;
    updateContribLocation();
    setContribStatus("已选点。建议区域：" + zoneLabel(zone) + "；可在上方手动修改。", "ok");
    var place = document.getElementById("contribPlace");
    if (place) place.focus();
  }

  function readContribFields() {
    function value(id) {
      var el = document.getElementById(id);
      return el ? el.value.trim() : "";
    }
    return {
      name: value("contribName"),
      zone: value("contribZone"),
      place: value("contribPlace"),
      time: value("contribTime"),
      notes: value("contribNotes"),
      contact: value("contribContact"),
      consent: !!(document.getElementById("contribConsent") && document.getElementById("contribConsent").checked)
    };
  }

  function validateContribution(fields) {
    if (!fields.name) {
      setContribStatus("请填写猫名或临时称呼。", "error");
      return false;
    }
    if (!fields.zone && contrib.x != null && contrib.y != null) {
      fields.zone = nearestZone(contrib.x, contrib.y);
      contrib.zone = fields.zone;
      var sel = document.getElementById("contribZone");
      if (sel) sel.value = fields.zone;
    }
    if (!fields.zone) {
      setContribStatus("请选择区域，或先在地图上选点。", "error");
      return false;
    }
    if (contrib.x == null || contrib.y == null) {
      setContribStatus("请先在地图上选点，标记猫咪出现的位置。", "error");
      return false;
    }
    if (!fields.consent) {
      setContribStatus("请先确认提交内容会公开在 GitHub Issue 上。", "error");
      return false;
    }
    return true;
  }

  function buildContribIssue(fields) {
    var zoneText = zoneLabel(fields.zone);
    var title = "[猫咪线索] " + fields.name + " · " + (fields.place || zoneText);
    var lines = [
      "### 猫咪线索",
      "",
      "- 猫名 / 临时称呼：" + fields.name,
      "- 区域：" + zoneText,
      "- 地点描述：" + (fields.place || "未填写"),
      "- 地图位置：x " + contrib.x.toFixed(1) + "%，y " + contrib.y.toFixed(1) + "%（示意地图百分比）",
      "- 目击时间：" + (fields.time ? fields.time.replace("T", " ") : "未填写"),
      "- 外观 / 备注：" + (fields.notes || "未填写"),
      "- 联系方式：" + (fields.contact || "未填写（可选）"),
      "- 定位：仅用于推荐区域，未保存原始 GPS",
      "- 提交确认：已确认公开",
      "",
      "> 由「校园猫分布地图」页面生成；提交内容会公开，并会自动收录到「读者补充（未核实）」图层。",
      "",
      "<!-- cat-sighting:v1 -->",
      "<!-- 请把猫咪照片拖到此处（可选）" + (contrib.photoName ? "：" + contrib.photoName : "") + " -->"
    ];
    return { title: title, body: lines.join("\n") };
  }

  function submitContribution() {
    var fields = readContribFields();
    if (!validateContribution(fields)) return;
    var issue = buildContribIssue(fields);
    var url = "https://github.com/" + ISSUE_REPO + "/issues/new?title=" +
      encodeURIComponent(issue.title) + "&body=" + encodeURIComponent(issue.body);
    var win = window.open(url, "_blank");
    if (win) {
      try { win.opener = null; } catch (e) {}
    }
    if (!win) {
      var status = document.getElementById("contribStatus");
      if (status) {
        status.className = "contrib-status is-error";
        status.textContent = "浏览器拦截了新标签页。请手动打开：";
        var link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "GitHub 提交页";
        status.appendChild(link);
      }
      return;
    }
    setContribStatus("已在新标签页打开 GitHub，请检查内容并点击 Create issue 完成提交。", "ok");
  }

  function copyContribution() {
    var fields = readContribFields();
    if (!validateContribution(fields)) return;
    var issue = buildContribIssue(fields);
    copyText(issue.title + "\n\n" + issue.body, function () {
      setContribStatus("已复制标题和内容，可粘贴到 GitHub 新建 Issue。", "ok");
    });
  }


  /* ---------- 未落图层 ---------- */
  var pendTab = "cats";

  function catById(id) {
    for (var i = 0; i < CATS.length; i++) {
      if (CATS[i].id === id) return CATS[i];
    }
    return null;
  }

  // 列表缩略图：进入视口附近才真正请求，避免首屏把 20+ 张图一起拉下来
  var thumbObserver = null;
  if ("IntersectionObserver" in window) {
    thumbObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var img = entry.target;
        if (img.dataset.src) {
          img.src = img.dataset.src;
          delete img.dataset.src;
        }
        thumbObserver.unobserve(img);
      });
    }, { rootMargin: "140px 0px" });
  }

  function pendThumb(photo, name, catId) {
    var src = photo || null;
    if (src && !/^(assets\/|data:image\/|https?:\/\/)/.test(src)) src = null;
    if (!src) return null;
    var img = makeEl("img", "pend-thumb");
    img.alt = (name || "猫") + " 的照片";
    img.loading = "lazy";
    img.decoding = "async";
    img.dataset.src = src;
    img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    img.onerror = function () { img.style.visibility = "hidden"; };
    if (thumbObserver) thumbObserver.observe(img);
    else img.src = src;
    return img;
  }

  function renderPending() {
    var list = document.getElementById("pendingList");
    list.textContent = "";
    document.getElementById("pendCatNum").textContent = PENDING_CATS.length;
    document.getElementById("pendSightNum").textContent = PENDING_SIGHTS.length;
    var pendingCatsNow = PENDING_CATS.filter(function (p) {
      var c = catById(p.catId);
      return c ? (!c.mergedInto && !isPlaced(c)) : true;
    }).length;
    document.getElementById("pendingSummary").textContent =
      "共 " + (pendingCatsNow + PENDING_SIGHTS.length) + " 条线索没有坐标（" +
      pendingCatsNow + " 只猫 + " + PENDING_SIGHTS.length + " 条目击）";
    var pendingTop = document.getElementById("pendingSummaryTop");
    if (pendingTop) pendingTop.textContent = document.getElementById("pendingSummary").textContent;

    if (pendTab === "cats") {
      PENDING_CATS.filter(function (p) {
        var c = catById(p.catId);
        return c ? (!c.mergedInto && !isPlaced(c)) : true;
      }).forEach(function (p) {
        var card = makeEl("div", "pend");
        var thumb = pendThumb(p.photo, p.nickname, p.catId);
        if (thumb) card.appendChild(thumb);

        var main = makeEl("div", "pend-main");
        var top = makeEl("div", "pend-top");
        top.appendChild(makeEl("span", "pend-name", p.nickname));
        if (p.aliases && p.aliases.length) {
          top.appendChild(makeEl("span", "pend-alias", "别名 " + p.aliases.join("、")));
        }
        top.appendChild(makeEl("span", "pend-missing", p.missing));
        main.appendChild(top);

        main.appendChild(makeEl("p", "pend-quote",
          p.quote ? "「" + p.quote + "」" : "原文未写地点，无法落点"));

        var inf = p.inference;
        if (inf) {
          var cands = (inf.candidates || []).filter(function (c) { return c && c.name; });
          if (cands.length) {
            main.appendChild(makeEl("p", "pend-quote",
              "图片推断候选：" + cands.map(function (c) {
                return c.name + "（" + Math.round(c.confidence * 100) + "%）";
              }).join("、") + " · 未经证实"));
          } else if (inf.noCue) {
            main.appendChild(makeEl("p", "pend-quote", "图片无可判读线索，保持未落点"));
          }
        }

        var foot = makeEl("div", "pend-foot");
        foot.appendChild(makeEl("span", null, p.sourcePost));

        var cat = catById(p.catId);
        if (cat) {
          var btn = makeEl("button", "pend-link", "查看卡片");
          btn.type = "button";
          btn.addEventListener("click", function () { openSheet(cat); });
          foot.appendChild(btn);
        }
        main.appendChild(foot);

        var acts = makeEl("div", "need-actions");
        var add = makeEl("button", "ghost-btn", "复制补充模板");
        add.type = "button";
        add.addEventListener("click", function () {
          copySupplement({ type: "cat", cat: cat, catId: p.catId }, add);
        });
        acts.appendChild(add);
        main.appendChild(acts);

        card.appendChild(main);
        list.appendChild(card);
      });
    } else {
      PENDING_SIGHTS.forEach(function (s) {
        var card = makeEl("div", "pend");
        var main = makeEl("div", "pend-main");
        var top = makeEl("div", "pend-top");
        top.appendChild(makeEl("span", "pend-name", s.title));
        top.appendChild(makeEl("span", "pend-missing", s.missing));
        main.appendChild(top);

        main.appendChild(makeEl("p", "pend-quote",
          (s.time || "日期未记") + " · 帖 #" + (s.listIndex || "?") + " · " +
          (s.photoCount || 0) + " 图" +
          (s.placeRaw ? " · 地点原文「" + s.placeRaw + "」" : "") +
          (s.reason ? " · " + s.reason : "")));

        if (s.note) main.appendChild(makeEl("p", "pend-quote", s.note));

        var inf = s.inference;
        var cand = inf && (inf.candidate || (inf.candidates && inf.candidates[0]));
        if (cand && cand.name) {
          main.appendChild(makeEl("p", "pend-quote",
            "图片推断候选：" + cand.name + "（" + Math.round((cand.confidence || 0) * 100) + "%）· 未经证实"));
        }

        var foot = makeEl("div", "pend-foot");
        foot.appendChild(makeEl("span", null,
          s.postRef + (s.possible && s.possible.length ? " · 可能：" + s.possible.join("、") : "")));
        main.appendChild(foot);

        var acts = makeEl("div", "need-actions");
        var add = makeEl("button", "ghost-btn", "复制补充模板");
        add.type = "button";
        add.addEventListener("click", function () {
          copySupplement({ type: "sighting", sighting: s }, add);
        });
        acts.appendChild(add);
        main.appendChild(acts);

        card.appendChild(main);
        list.appendChild(card);
      });
    }
  }

  function renderMerges() {
    var section = document.getElementById("mergeSection");
    var box = document.getElementById("mergeList");
    box.textContent = "";
    mergeRows = [];

    var groups = Array.isArray(DATA.mergeGroups) && DATA.mergeGroups.length
      ? DATA.mergeGroups
      : MERGES.map(function (m, i) {
          return {
            id: "M" + i, aId: m.a, bId: m.b, aName: m.aName, bName: m.bName,
            similarity: m.similarity, basis: m.basis, mergeable: true
          };
        });
    if (!groups.length) { section.hidden = true; return; }

    var direct = 0;

    groups.forEach(function (g) {
      var a = catById(g.aId);
      var b = catById(g.bId);
      var merged = (a && a.mergedInto) || (b && b.mergedInto);
      var mergeable = !!g.mergeable && !merged && a && b;
      if (mergeable) direct += 1;

      var row = makeEl("div", "merge-row" + (merged ? " is-merged" : ""));
      var check = makeEl("input", "merge-check");
      check.type = "checkbox";
      check.disabled = !mergeable;
      check.checked = !!mergeSelections[g.id];
      check.addEventListener("change", function () {
        mergeSelections[g.id] = check.checked;
      });
      row.appendChild(check);

      var pair = makeEl("div", "merge-pair");
      [["a", g.aName, g.aId], ["b", g.bName, g.bId]].forEach(function (item, i) {
        if (i === 1) pair.appendChild(makeEl("span", null, "↔"));
        var cat = catById(item[2]);
        if (!cat) {
          pair.appendChild(makeEl("span", null, item[1]));
          return;
        }
        var btn = makeEl("button", "merge-name", item[1]);
        btn.type = "button";
        btn.addEventListener("click", function () { openSheet(cat); });
        pair.appendChild(btn);
      });
      if (typeof g.similarity === "number") {
        pair.appendChild(makeEl("span", "merge-sim", Math.round(g.similarity * 100) + "%"));
      }
      row.appendChild(pair);

      if (merged) {
        var into = a && a.mergedInto ? catById(a.mergedInto) : (b && b.mergedInto ? catById(b.mergedInto) : null);
        row.appendChild(makeEl("span", "merge-tag", "已合并" + (into ? " → " + into.nickname : "")));
      } else if (!g.mergeable) {
        row.appendChild(makeEl("span", "merge-tag", "需人工核对"));
      }

      if (g.basis) row.appendChild(makeEl("span", "merge-basis", g.basis));
      mergeRows.push({ id: g.id, aId: g.aId, bId: g.bId, mergeable: mergeable, reader: false });
      box.appendChild(row);
    });

    // 读者新填的别名匹配，也进入可勾选合并
    QUEUE.forEach(function (q, i) {
      if (!q.alias || !q.aliasCatId) return;
      var a = catById(q.catId);
      var b = catById(q.aliasCatId);
      if (!a || !b || a.mergedInto || b.mergedInto) return;

      var id = "Q" + i;
      var row = makeEl("div", "merge-row");
      var check = makeEl("input", "merge-check");
      check.type = "checkbox";
      check.checked = !!mergeSelections[id];
      check.addEventListener("change", function () { mergeSelections[id] = check.checked; });
      row.appendChild(check);

      var pair = makeEl("div", "merge-pair");
      [a, b].forEach(function (cat, k) {
        if (k === 1) pair.appendChild(makeEl("span", null, "↔"));
        var btn = makeEl("button", "merge-name", cat.nickname);
        btn.type = "button";
        btn.addEventListener("click", function () { openSheet(cat); });
        pair.appendChild(btn);
      });
      row.appendChild(pair);
      row.appendChild(makeEl("span", "merge-tag is-reader", "读者填写"));
      row.appendChild(makeEl("span", "merge-basis",
        "第 " + (q.id || i + 1) + " 条补充：别名「" + q.alias + "」；提交地点「" + q.place + "」；勾选后把前者并入后者。"));
      mergeRows.push({ id: id, aId: q.catId, bId: q.aliasCatId, mergeable: true, reader: true });
      box.appendChild(row);
    });

    var queueOpen = QUEUE.filter(function (q) { return !q.resolved; }).length;
    document.getElementById("mergeSummary").textContent =
      groups.length + " 组疑似 · " + direct + " 组可勾选 · 已合并 " +
      MERGE_EVENTS.length + " 次" + (queueOpen ? " · 待合并队列 " + queueOpen + " 条" : "");
    var mergeTop = document.getElementById("mergeSummaryTop");
    if (mergeTop) mergeTop.textContent = document.getElementById("mergeSummary").textContent;
  }

  /* ---------- 最需要补充 ---------- */
  function needList() {
    var placeItems = PENDING_CATS.slice().sort(function (a, b) {
      var ai = a.inference && (a.inference.candidates || []).length ? 0 : 1;
      var bi = b.inference && (b.inference.candidates || []).length ? 0 : 1;
      return ai - bi;
    }).map(function (p) {
      var cat = catById(p.catId);
      var cands = (p.inference && p.inference.candidates || []).filter(function (c) { return c && c.name; });
      var why;
      if (cands.length) {
        why = "原文：" + p.missing + "；图片只能给到候选 " +
          cands.map(function (c) { return c.name + " " + Math.round(c.confidence * 100) + "%"; }).join(" / ") +
          "，需要有人确认具体楼号或喂食点。";
      } else {
        why = (p.missing || "原文未写地点") + "；配图也无可判读线索，只能靠现场补充。";
      }
      return { name: p.nickname, why: why, cat: cat, catId: p.catId, type: "cat" };
    });

    var nameItems = [
      { id: "C11", why: "帖内在求名，“凑近就叫”的描述不足以区分个体。" },
      { id: "C2-11", why: "“小肥肥”是外观描述式临时名，尚未确认对应哪一只。" },
      { id: "C2-10", why: "“小黑猫”是泛称，校园里黑猫不止一只，容易混淆。" },
      { id: "C2-08", why: "“体型最大的一只”是描述式称呼，不是固定名字。" }
    ].map(function (x) {
      var cat = catById(x.id);
      return { name: cat ? cat.nickname : x.id, why: x.why, cat: cat, catId: x.id, type: "cat" };
    });

    var mergeItems = (Array.isArray(DATA.mergeGroups) && DATA.mergeGroups.length
      ? DATA.mergeGroups
      : MERGES
    ).map(function (m) {
      var idA = m.aId || m.a;
      var a = catById(idA);
      return {
        name: m.aName + " ↔ " + m.bName,
        why: "相似度 " + Math.round((m.similarity || 0) * 100) + "%，但" +
          (m.basis || "缺地点或外观证据") +
          "；需要同一时段的对照图或共同目击，可在「待确认合并」勾选后合并/撤销。",
        cat: a,
        catId: idA,
        type: "cat"
      };
    });

    var statusItems = [
      { id: "C17", why: "健康求助帖，状态与位置都未确认，需要目击者更新近况。" },
      { id: "C2-15", why: "“光华门前不适猫”，校区（光华校区/光华村）和具体门都未定。" },
      { id: "C05", why: "坐标置信度仅 45%，只到“柳林体育馆一带”的区域级。" },
      { id: "C2-14", why: "敏园门口两只群体记录，位置 45%，需要分别确认两只个体。" }
    ].map(function (x) {
      var cat = catById(x.id);
      return { name: cat ? cat.nickname : x.id, why: x.why, cat: cat, catId: x.id, type: "cat" };
    });

    return [
      { title: "缺地点", hint: PENDING_CATS.length + " 只", items: placeItems },
      { title: "名字冲突", hint: nameItems.length + " 处", items: nameItems },
      { title: "疑似同一只", hint: MERGES.length + " 组", items: mergeItems },
      { title: "状态待确认", hint: statusItems.length + " 处", items: statusItems }
    ];
  }

  function renderNeedGroups() {
    var box = document.getElementById("needGroups");
    box.textContent = "";

    var groups = needList();
    document.getElementById("needSummary").textContent =
      groups.map(function (g) { return g.title + " " + g.items.length; }).join(" · ");
    var needTop = document.getElementById("needSummaryTop");
    if (needTop) needTop.textContent = document.getElementById("needSummary").textContent;

    groups.forEach(function (g) {
      var wrap = makeEl("div", "need-group");
      var head = makeEl("div", "need-head", g.title);
      head.appendChild(makeEl("span", null, g.hint));
      wrap.appendChild(head);

      var shown = g.items.slice(0, g.title === "缺地点" ? 8 : 6);
      shown.forEach(function (item) {
        var row = makeEl("div", "need-item");
        row.appendChild(makeEl("span", "need-name", item.name));
        row.appendChild(makeEl("span", "need-why", item.why));

        var acts = makeEl("span", "need-actions");
        if (item.cat) {
          var look = makeEl("button", "mini-link", "打开卡片填写");
          look.type = "button";
          look.addEventListener("click", function () { openSheet(item.cat); });
          acts.appendChild(look);
          var copy = makeEl("button", "ghost-btn", "复制模板");
          copy.type = "button";
          copy.addEventListener("click", function () {
            copySupplement({ type: "cat", cat: item.cat }, copy);
          });
          acts.appendChild(copy);
        }
        row.appendChild(acts);
        wrap.appendChild(row);
      });

      if (g.items.length > shown.length) {
        var more = makeEl("div", "need-item");
        more.appendChild(makeEl("span", "need-why",
          "另有 " + (g.items.length - shown.length) + " 条同类问题，完整清单见「未落图」与「待确认合并」。"));
        wrap.appendChild(more);
      }

      box.appendChild(wrap);
    });

    updatePatchCount();
  }

  /* ---------- 读者补充：localStorage 队列 / 地标匹配 / 合并 ---------- */
  var QUEUE_KEY = "campusCats.readerQueue.v1";
  var MERGE_KEY = "campusCats.mergeEvents.v1";
  var MEM_STORE = {};
  var STORE_OK = (function () {
    try {
      var probe = "__campusCatsStorageProbe__";
      window.localStorage.setItem(probe, "1");
      window.localStorage.removeItem(probe);
      return true;
    } catch (e) { return false; }
  })();

  function showStorageNote() {
    var note = document.getElementById("storageNote");
    if (!note) return;
    if (STORE_OK) { note.hidden = true; return; }
    note.hidden = false;
    note.textContent = "当前环境写不进 localStorage：填写和合并只在本次会话内有效，刷新后可能丢失。请用「复制补充文本」或「导出补丁 JSON」保存结果。";
  }

  function loadJSON(key, fallback) {
    try {
      var raw = STORE_OK ? window.localStorage.getItem(key) : MEM_STORE[key];
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch (e) { return fallback; }
  }

  function saveJSON(key, value) {
    var raw = JSON.stringify(value);
    if (STORE_OK) {
      try { window.localStorage.setItem(key, raw); return; }
      catch (e) { STORE_OK = false; }
    }
    MEM_STORE[key] = raw;
    showStorageNote();
  }

  var QUEUE = loadJSON(QUEUE_KEY, []);
  var MERGE_EVENTS = loadJSON(MERGE_KEY, []);
  var mergeSelections = {};
  var mergeRows = [];

  function catOfCtx(ctx) {
    if (!ctx) return null;
    if (ctx.cat) return catById(ctx.cat.id) || ctx.cat;
    if (ctx.catId) return catById(ctx.catId);
    return null;
  }

  function findCatByName(name) {
    var q = (name || "").trim().toLowerCase();
    if (!q) return null;
    var found = null;
    CATS.some(function (c) {
      if (c.mergedInto) return false;
      var names = [c.nickname || ""].concat(c.aliases || []).map(function (n) {
        return n.trim().toLowerCase();
      });
      if (names.indexOf(q) >= 0) { found = c; return true; }
      if (names.some(function (n) { return n && n.length >= 2 && q.indexOf(n) >= 0; })) {
        found = c;
        return false;
      }
      return false;
    });
    return found;
  }

  /* 地标别名表：楼号 / 片区 / 门 / 湖 / 场馆都从这里匹配 */
  var EXTRA_PLACE_ALIASES = [
    { name: "柳湖", keys: ["柳湖", "柳湖边", "柳湖畔"] },
    { name: "五谷堂", keys: ["五谷堂", "五谷堂后门", "五谷堂侧门", "五谷堂门口"] },
    { name: "榕园", keys: ["榕园"] },
    { name: "竹园", keys: ["竹园"] },
    { name: "梅园", keys: ["梅园"] },
    { name: "敏园", keys: ["敏园"] },
    { name: "智园", keys: ["智园"] },
    { name: "食堂", keys: ["食堂", "学生食堂", "一食堂", "二食堂"] },
    { name: "东门", keys: ["东门", "东大门"] },
    { name: "北门", keys: ["北门"] },
    { name: "西门", keys: ["西门"] },
    { name: "南门", keys: ["南门"] },
    { name: "柳林体育馆", keys: ["柳林体育馆", "体育馆"] },
    { name: "朝晖体育场", keys: ["朝晖体育场", "朝晖操场", "朝晖"] },
    { name: "晨曦体育场", keys: ["晨曦体育场", "晨曦操场", "晨曦"] },
    { name: "校医院", keys: ["校医院", "校医室"] },
    { name: "刘诗白书院", keys: ["刘诗白", "刘诗白书院"] },
    { name: "经世楼", keys: ["经世楼"] },
    { name: "尔静桥", keys: ["尔静桥"] }
  ];

  function normalizePlace(s) {
    return (s || "").replace(/\s+/g, "").toLowerCase();
  }

  function buildPlaceIndex() {
    var index = [];
    LANDMARKS.forEach(function (l) {
      var keys = [l.name];
      if (l.code) {
        keys.push(l.code + "号", l.code + "号楼", l.code + "栋", l.code + "楼",
          l.code + "号楼旁", l.code + "栋旁", l.code + "号楼旁边", l.code + "栋旁边");
      }
      EXTRA_PLACE_ALIASES.forEach(function (e) {
        if (e.name === l.name) keys = keys.concat(e.keys);
      });
      var zone = l.kind === "dorm" ? "dorm" :
        (l.kind === "teaching" ? "teaching" :
        (l.kind === "canteen" ? "canteen" : "other"));
      keys.forEach(function (k) {
        index.push({
          key: normalizePlace(k), name: l.name, x: l.x, y: l.y,
          zone: zone, code: l.code || null
        });
      });
    });
    return index;
  }

  var PLACE_INDEX = buildPlaceIndex();

  function matchPlace(raw) {
    var q = normalizePlace(raw);
    if (!q || q.length < 2) return null;
    var best = null;
    PLACE_INDEX.forEach(function (e) {
      if (!e.key) return;
      var hit = q.indexOf(e.key) >= 0 || (e.key.length >= 2 && e.key.indexOf(q) >= 0);
      if (!hit) return;
      if (!best || e.key.length > best.key.length) best = e;
    });
    return best;
  }

  // 读者地点落到地标，标记为“读者补充，未核实”
  function applyReaderPlace(cat, raw) {
    if (!cat) return { ok: false, reason: "no-cat" };
    if (isPlaced(cat) && !cat.readerAdded) {
      cat.readerNote = "读者补充地点：" + raw + "（未覆盖已核实坐标）";
      return { ok: true, already: true, name: cat.place };
    }
    var match = matchPlace(raw);
    if (!match) {
      cat.readerMiss = { raw: raw, at: stamp() };
      return { ok: false, reason: "no-match" };
    }
    var same = CATS.filter(function (c) {
      return !c.mergedInto && c.readerAdded && c.readerAdded.matchName === match.name;
    }).length;
    cat.x = match.x;
    cat.y = match.y;
    cat.zone = match.zone;
    cat.dx = -26;
    cat.dy = -24 - same * 30;
    cat.place = match.name + "（" + raw + "）";
    cat.confidence = 0.5;
    cat.readerAdded = {
      raw: raw,
      matchName: match.name,
      landmarkCode: match.code,
      confidence: 0.5,
      at: stamp()
    };
    delete cat.readerMiss;
    return { ok: true, match: match };
  }

  function restoreLocalState() {
    QUEUE.forEach(function (q) {
      var cat = catById(q.catId);
      if (cat && !cat.mergedInto) applyReaderPlace(cat, q.place);
    });
    MERGE_EVENTS.forEach(function (ev) {
      applyMerge(ev.from, ev.into, ev.by, { silent: true });
    });
  }

  function supplementInfo(ctx) {
    var cat = catOfCtx(ctx);

    if (ctx.type === "spot") {
      var spot = ctx.spot;
      return {
        catId: spot.id,
        targetType: "sighting-spot",
        title: spot.name,
        detail: (spot.method === "image" ? "图片推断目击点" : "原文地点目击点") +
          " · " + (Number(spot.count) || 1) + " 条 · 置信度 " +
          Math.round((spot.confidence || 0) * 100) + "%",
        coord: spot.x + ", " + spot.y,
        candidates: (spot.cues || []).join("；"),
        sourceUrl: spot.sourceUrl || (spot.entries && spot.entries[0] && spot.entries[0].sourceUrl) || ""
      };
    }

    if (ctx.type === "sighting") {
      var s = ctx.sighting;
      var inf = s.inference || {};
      var cand = inf.candidate || (inf.candidates && inf.candidates[0]);
      return {
        catId: "SIGHT-" + (s.listIndex || "?"),
        targetType: "unidentified-sighting",
        title: s.title,
        detail: "未归属目击 · 帖 #" + (s.listIndex || "?") + " · " + (s.time || "日期未记") +
          " · " + (s.photoCount || 0) + " 图",
        coord: "未落点",
        candidates: cand && cand.name
          ? cand.name + "（" + Math.round((cand.confidence || 0) * 100) + "%）"
          : "图片无可判读线索",
        sourceUrl: s.url || ""
      };
    }

    var name = cat ? (cat.nickname || "未命名") : (ctx.catId || "未命名");
    var coordText;
    if (cat && isPlaced(cat)) {
      coordText = (cat.readerAdded ? "读者补充 " : "已落点 ") + cat.x + ", " + cat.y +
        "（置信度 " + Math.round((cat.confidence || 0) * 100) + "%）";
    } else if (cat && inferable(cat)) {
      coordText = "未落点；推断候选：" + cat.inference.candidates.map(function (c) {
        return c.name + " " + Math.round(c.confidence * 100) + "%";
      }).join(" / ");
    } else {
      coordText = "未落点" + (cat && noCue(cat) ? "；图片无可判读线索" : "");
    }

    return {
      catId: ctx.catId || (cat ? cat.id : "未命名"),
      targetType: "cat",
      title: name,
      detail: (cat ? (ZONES[cat.zone] || "未分类") : "未分类") + " · " +
        (isPlaced(cat) ? cat.place : "未落点"),
      coord: coordText,
      candidates: cat && inferable(cat)
        ? cat.inference.candidates.map(function (c) { return c.name; }).join(" / ")
        : "—",
      sourceUrl: (cat && cat.sourceUrl) || (cat && cat.sourcePost) || ""
    };
  }

  function stamp() {
    var d = new Date();
    function p(n) { return n < 10 ? "0" + n : "" + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
      p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function missingFields(cat) {
    return {
      place: cat.place ? null : "地点待补充",
      activeTime: cat.activeTime ? null : "活跃时段未记录",
      appearance: cat.appearance ? null : "外观仅文字描述/无",
      status: cat.status ? null : "状态暂无"
    };
  }

  function slotStats() {
    var cats = CATS.filter(function (c) { return !c.mergedInto && !isPlaced(c); });
    var slots = 0;
    var missing = 0;
    cats.forEach(function (c) {
      var f = missingFields(c);
      Object.keys(f).forEach(function (k) {
        slots += 1;
        if (f[k]) missing += 1;
      });
    });
    return { cats: cats.length, slots: slots, missing: missing, filled: slots - missing };
  }

  function buildSupplementText(ctx) {
    var info = supplementInfo(ctx);
    var cat = catOfCtx(ctx);
    var lines = [
      "【校园猫地图 · 补充请求】",
      "catId: " + info.catId,
      "目标: " + info.title,
      "目标类型: " + info.targetType,
      "当前坐标/推断候选: " + info.coord,
      "推断候选地点: " + (info.candidates || "—"),
      "原文链接: " + (info.sourceUrl || "—")
    ];

    if (cat && !isPlaced(cat)) {
      var missing = missingFields(cat);
      lines.push("待补充字段:");
      Object.keys(missing).forEach(function (k) {
        lines.push("  - " + ({ place: "地点", activeTime: "活跃时段", appearance: "外观", status: "状态" }[k]) +
          ": " + (missing[k] || "已有文字记录"));
      });
    }
    lines.push("提交地点: 待填写（需楼栋 + 方位，例如：竹园 3 栋楼下 / 五谷堂后门）");
    lines.push("补充说明: 待填写");
    lines.push("是否目击: 待填写");
    lines.push("生成时间: " + stamp());
    return lines.join("\n");
  }

  function updateQueueBadge() {
    var unresolved = QUEUE.filter(function (q) { return !q.resolved; }).length;
    document.getElementById("queueCount").textContent = unresolved;
    document.getElementById("queueBadge").classList.toggle("badge-sample", unresolved > 0);
    updatePatchCount();
  }

  function copyText(text, ok) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok).catch(function () { fallbackCopy(text, ok); });
    } else {
      fallbackCopy(text, ok);
    }
  }

  function fallbackCopy(text, ok) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px;top:0;";
    document.body.appendChild(ta);
    ta.select();
    var done = false;
    try { done = document.execCommand("copy"); } catch (e) { done = false; }
    document.body.removeChild(ta);
    ok(done);
  }

  function copySupplement(ctx, btn) {
    var text = buildSupplementText(ctx);
    copyText(text, function (ok) {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = ok ? "已复制补充文本" : "复制失败，请手动选择";
      setTimeout(function () { btn.textContent = old; }, 1600);
    });
  }

  function submitReaderForm(cat, fields, tip) {
    var place = (fields.place.value || "").trim();
    if (!place) {
      tip.textContent = "地点为必填项：至少写到楼号、片区或地标名，例如「竹园 3 栋楼下」。";
      fields.place.focus();
      return;
    }

    var alias = (fields.alias.value || "").trim();
    var note = (fields.note.value || "").trim();
    var saw = !!fields.saw.checked;
    var aliasCat = alias ? findCatByName(alias) : null;
    if (aliasCat && aliasCat.id === cat.id) aliasCat = null;

    var placeRes = applyReaderPlace(cat, place);

    QUEUE.push({
      id: "Q-" + (QUEUE.length + 1),
      catId: cat.id,
      nickname: cat.nickname || "未命名",
      place: place,
      alias: alias,
      aliasCatId: aliasCat ? aliasCat.id : null,
      note: note,
      saw: saw,
      submittedAt: stamp(),
      resolved: false
    });
    saveJSON(QUEUE_KEY, QUEUE);

    var msgs = [];
    if (placeRes.ok && placeRes.match) {
      msgs.push("地点匹配到「" + placeRes.match.name + "」，已落点（读者补充，未核实）");
    } else if (placeRes.ok && placeRes.already) {
      msgs.push("该猫已有已核实坐标，读者地点仅作为备注");
    } else {
      msgs.push("地点未匹配到地标，已进入待定位；请补充「楼栋 + 方位」后重新提交");
    }
    if (aliasCat) msgs.push("别名匹配到「" + aliasCat.nickname + "」，已加入待确认合并");
    else if (alias) msgs.push("别名未匹配到现有猫名，仅作为文字记录保留");

    tip.textContent = msgs.join("；") + (STORE_OK
      ? "。已存入本机待合并队列（刷新不丢）。"
      : "。已存入本次会话队列（刷新后可能丢失）。");
    QUEUE[QUEUE.length - 1].result = msgs.join("；");
    saveJSON(QUEUE_KEY, QUEUE);

    updateQueueBadge();
    render();
    renderMerges();
    renderNeedGroups();
    renderPending();
  }

  function chooseMaster(aId, bId) {
    var a = catById(aId);
    var b = catById(bId);
    if (!a) return b;
    if (!b) return a;
    if (isPlaced(a) && !isPlaced(b)) return a;
    if (!isPlaced(a) && isPlaced(b)) return b;
    var score = function (c) {
      return (c.photo ? 2 : 0) + (c.sourceUrl ? 1 : 0) + ((c.aliases || []).length);
    };
    return score(a) >= score(b) ? a : b;
  }

  function deepClone(v) { return JSON.parse(JSON.stringify(v)); }

  function applyMerge(fromId, intoId, by, opts) {
    var from = catById(fromId);
    var into = catById(intoId);
    if (!from || !into || from.id === into.id || from.mergedInto || into.mergedInto) return null;

    var snapshot = { from: deepClone(from), into: deepClone(into) };

    into.aliases = (into.aliases || []).slice();
    [from.nickname].concat(from.aliases || []).forEach(function (n) {
      if (n && into.aliases.indexOf(n) < 0) into.aliases.push(n);
    });
    into.mergedFrom = (into.mergedFrom || []).concat([{
      id: from.id,
      nickname: from.nickname,
      place: from.place || "",
      sourcePost: from.sourcePost || "",
      sourceUrl: from.sourceUrl || "",
      photo: from.photo || "",
      quote: from.quote || "",
      at: stamp()
    }]);

    if (from.sourcePost) {
      into.sourcePost = into.sourcePost
        ? (into.sourcePost.indexOf(from.sourcePost) >= 0 ? into.sourcePost : into.sourcePost + "；" + from.sourcePost)
        : from.sourcePost;
    }

    if (!isPlaced(into) && isPlaced(from)) {
      into.x = from.x;
      into.y = from.y;
      into.dx = from.dx;
      into.dy = from.dy;
      into.zone = into.zone || from.zone;
      into.place = into.place || from.place;
      into.confidence = Math.min(0.5, Number(from.confidence) || 0.5);
      into.readerAdded = {
        raw: "合并自 " + from.nickname,
        matchName: from.readerAdded ? from.readerAdded.matchName : (from.place || ""),
        confidence: into.confidence,
        inheritedFrom: from.id,
        at: stamp()
      };
    }

    from.mergedInto = into.id;

    QUEUE.forEach(function (q) {
      if (q.catId === from.id && q.alias) q.resolved = true;
    });
    saveJSON(QUEUE_KEY, QUEUE);

    var ev = {
      id: "MG-" + (MERGE_EVENTS.length + 1),
      from: from.id,
      into: into.id,
      fromName: from.nickname,
      intoName: into.nickname,
      by: by || "读者（本页操作）",
      time: stamp(),
      snapshot: snapshot
    };

    if (!opts || !opts.silent) {
      MERGE_EVENTS.push(ev);
      saveJSON(MERGE_KEY, MERGE_EVENTS);
    }

    if (!opts || !opts.silent) {
      closeSheet();
      render();
      renderMerges();
      renderNeedGroups();
      renderPending();
      updateQueueBadge();
    }

    return ev;
  }

  function undoMerge() {
    if (!MERGE_EVENTS.length) return;
    var ev = MERGE_EVENTS.pop();
    saveJSON(MERGE_KEY, MERGE_EVENTS);

    var iFrom = -1;
    var iInto = -1;
    CATS.forEach(function (c, i) {
      if (c.id === ev.from) iFrom = i;
      if (c.id === ev.into) iInto = i;
    });
    if (iFrom >= 0) CATS[iFrom] = ev.snapshot.from;
    if (iInto >= 0) CATS[iInto] = ev.snapshot.into;

    QUEUE.forEach(function (q) {
      if (q.catId === ev.from && q.alias) q.resolved = false;
    });
    saveJSON(QUEUE_KEY, QUEUE);

    render();
    renderMerges();
    renderNeedGroups();
    renderPending();
    updateQueueBadge();
  }

  function updatePatchCount() {
    var el = document.getElementById("patchCount");
    var st = slotStats();
    el.hidden = false;
    el.textContent = "当前有 " + st.cats + " 只未落点猫，共 " + st.slots + " 个字段位，其中 " +
      st.missing + " 个为真空白（虚线框），" + st.filled + " 个已有文字/状态。" +
      "读者队列 " + QUEUE.length + " 条，合并 " + MERGE_EVENTS.length + " 次。";
  }

  function buildPatch() {
    var patches = CATS.filter(function (c) { return !c.mergedInto; }).map(function (c) {
      var missing = missingFields(c);
      var hasMissing = !isPlaced(c) || Object.keys(missing).some(function (k) { return missing[k]; });
      if (!hasMissing && !c.readerAdded) return null;
      return {
        catId: c.id,
        nickname: c.nickname || "未命名",
        missing: missing,
        inferenceCandidates: inferable(c)
          ? c.inference.candidates.map(function (x) {
              return { name: x.name, zone: x.zone, x: x.x, y: x.y, confidence: x.confidence, cue: x.cue };
            })
          : [],
        readerAdded: c.readerAdded || null,
        readerMiss: c.readerMiss || null,
        patch: {
          id: c.id,
          nickname: c.nickname || null,
          place: c.place || null,
          x: isPlaced(c) ? c.x : null,
          y: isPlaced(c) ? c.y : null,
          zone: c.zone || null,
          confidence: c.confidence || null,
          activeTime: c.activeTime || null,
          appearance: c.appearance || null,
          status: c.status || null,
          aliases: c.aliases || [],
          note: c.note || null,
          sourcePost: c.sourcePost || null,
          sourceUrl: c.sourceUrl || null,
          photo: c.photo || null
        }
      };
    }).filter(Boolean);

    return {
      schema: "campus-cats-patch/v2",
      generatedAt: new Date().toISOString(),
      baseData: {
        schemaVersion: META.schemaVersion || "",
        catCount: CATS.length,
        landedCats: CATS.filter(function (c) { return isPlaced(c) && !c.mergedInto; }).length,
        sightingSpots: SIGHT_SPOTS.length,
        pendingCats: PENDING_CATS.length,
        pendingSightings: PENDING_SIGHTS.length
      },
      notes: "空白补丁 + 读者补充队列；不联网、不自动导入、不自动合并，需人工核对后并入 cats.json。",
      patches: patches,
      readerQueue: QUEUE,
      merged: MERGE_EVENTS.map(function (e) {
        return { from: e.from, into: e.into, by: e.by, time: e.time };
      }),
      emptyBlocks: EMPTY_BLOCKS.map(function (b) {
        return {
          name: b.name, x: b.x, y: b.y, w: b.w, h: b.h,
          missing: ["具名猫地点", "活跃时段", "外观记录", "目击记录"]
        };
      }),
      needs: needList().map(function (g) {
        return {
          type: g.title,
          count: g.items.length,
          items: g.items.slice(0, 8).map(function (x) {
            return { catId: x.catId, name: x.name, why: x.why };
          })
        };
      })
    };
  }

  function downloadPatch() {
    var json = JSON.stringify(buildPatch(), null, 2);
    var blob = new Blob([json], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cat-map-patch.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1200);
  }

  /* ---------- 事件 ---------- */
  lowToggle.addEventListener("change", function () {
    state.showLow = lowToggle.checked;
    afterLayerChange();
  });

  catToggle.addEventListener("change", function () {
    state.showCats = catToggle.checked;
    afterLayerChange();
  });

  sightToggle.addEventListener("change", function () {
    state.showSights = sightToggle.checked;
    afterLayerChange();
  });

  inferToggle.addEventListener("change", function () {
    state.showInference = inferToggle.checked;
    afterLayerChange();
  });

  document.getElementById("exportPatch").addEventListener("click", downloadPatch);

  document.getElementById("copyAllSlots").addEventListener("click", function () {
    var parts = CATS.filter(function (c) { return !c.mergedInto && !isPlaced(c); })
      .map(function (c) { return buildSupplementText({ type: "cat", cat: c }); });
    if (!parts.length) return;
    copyText(parts.join("\n\n" + "—".repeat(24) + "\n\n"), function () {});
  });

  document.getElementById("mergeSelected").addEventListener("click", function () {
    var picked = mergeRows.filter(function (r) { return mergeSelections[r.id] && r.mergeable; });
    picked.forEach(function (row) {
      var master;
      if (row.reader) {
        master = catById(row.bId);
      } else {
        master = chooseMaster(row.aId, row.bId);
      }
      var other = master && master.id === row.aId ? catById(row.bId) : catById(row.aId);
      if (master && other) applyMerge(other.id, master.id, "读者（本页操作）");
    });
    mergeSelections = {};
    renderMerges();
  });

  document.getElementById("undoMerge").addEventListener("click", undoMerge);

  Array.prototype.forEach.call(
    document.querySelectorAll("#pendingTabs button"),
    function (btn) {
      btn.addEventListener("click", function () {
        pendTab = btn.dataset.tab;
        Array.prototype.forEach.call(
          document.querySelectorAll("#pendingTabs button"),
          function (b) { b.setAttribute("aria-pressed", b === btn ? "true" : "false"); }
        );
        renderPending();
      });
    }
  );

  backdrop.addEventListener("click", closeSheet);
  document.getElementById("contributeBtn").addEventListener("click", openContributeSheet);
  document.getElementById("pickCancel").addEventListener("click", function () {
    stopPickMode(true);
    setContribStatus("已取消选点。", "");
  });
  document.getElementById("historyClear").addEventListener("click", clearCatHistory);

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (contrib.picking) {
      stopPickMode(true);
      setContribStatus("已取消选点。", "");
      return;
    }
    if (!sheet.hidden) closeSheet();
  });

  /* ---------- 启动 ---------- */
  initText();
  showStorageNote();
  applyCalibration();
  chipsBox.classList.add("chips-ready");
  positionChipInk(false);
  bindChips();
  restoreLocalState();
  render();
  renderMerges();
  renderNeedGroups();
  renderPending();
  updateQueueBadge();
})();

