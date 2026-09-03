/* ============================================================
 * 3D 太阳系模拟器
 * 依赖：three.js r128 + OrbitControls（全局 THREE）
 * 实现：原生 ES5 语法，整体以 IIFE 封装
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- 基础工具 ---------- */

  function $(id) { return document.getElementById(id); }

  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function cssColor(hex) {
    var c = hexToRgb(hex);
    return 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')';
  }

  /* ---------- 错误兜底 ---------- */

  function showFatal(msg) {
    console.error('[Solar System] 致命错误：' + msg);
    var loading = $('loading');
    if (loading) loading.style.display = 'none';
    var el = $('err');
    if (!el) {
      el = document.createElement('div');
      el.id = 'err';
      el.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:99;' +
        'padding:20px 28px;max-width:80vw;background:rgba(24,10,10,0.95);border:1px solid #a33;' +
        'border-radius:10px;color:#ffb4a8;font-size:14px;line-height:1.8;text-align:left;';
      document.body.appendChild(el);
    }
    el.style.display = 'block';
    el.innerHTML = '加载 / 运行失败：' + msg +
      '<br><br>请确认 js/three.min.js（three.js r128）与 js/OrbitControls.js 与本项目匹配。';
    throw new Error(msg);
  }

  if (typeof window.THREE === 'undefined') {
    showFatal('未检测到 THREE（three.js r128 未加载）');
    return;
  }

  /* ---------- 全局参数 ---------- */

  var TWO_PI = Math.PI * 2;
  var DAYS_PER_YEAR = 365;
  var SPIN_VIS = 1.31e-5;      // 自转视觉系数（弧度/毫秒/天每秒）

  var dps = 0;                 // 当前时间速度：天/秒（由 speed 滑杆控制）
  var paused = false;
  var solarSpin = 10;          // 太阳系旋转倍速（0~20，由"太阳系旋转倍速"滑杆控制）
  var SOLAR_SPIN_BASE = 0.02;  // 基础角速度（弧度/秒/倍速单位），10x 约 31 秒转一圈

  /* ---------- 渲染器 / 场景 / 相机 ---------- */

  var holder = $('scene-container') || $('app');
  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch (e) {
    showFatal('WebGL 初始化失败：' + e.message + '（请更换支持 WebGL 的现代浏览器）');
    return;
  }
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  /* 阴影贴图：土星球体与光环互相遮挡、互相投影（球体阴影切过光环，光环在球体暗面投下拱形黑影） */
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  holder.appendChild(renderer.domElement);

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000005);

  var camera = new THREE.PerspectiveCamera(
    55, window.innerWidth / window.innerHeight, 0.1, 20000
  );
  var HOME_POS = new THREE.Vector3(0, 85, 230);
  camera.position.copy(HOME_POS);
  camera.lookAt(0, 0, 0);

  var controls = null;
  if (typeof THREE.OrbitControls === 'function') {
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.6;
    controls.zoomSpeed = 0.9;
    controls.minDistance = 8;
    controls.maxDistance = 4000;
    controls.autoRotate = false;     // 相机不自动环绕；“太阳系旋转倍速”滑杆改为旋转 solarGroup
  } else {
    showFatal('未检测到 THREE.OrbitControls');
    return;
  }

  /* ---------- 光照系统（模块 7：buildLighting） ---------- */

  /* 环境光（AmbientLight）提供基础照明，
     点光源（PointLight）置于原点模拟太阳光照。
     返回 { ambient, sunLight } */
  function buildLighting(sc) {
    var ambient = new THREE.AmbientLight(0x404050, 0.55);
    sc.add(ambient);

    var sunLight = new THREE.PointLight(0xfff2cc, 1.6, 0, 2);
    sunLight.position.set(0, 0, 0); // 原点 = 太阳中心
    /* 太阳点光源投影：near 在太阳球面之外，far 覆盖土星轨道 */
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(1024, 1024);
    sunLight.shadow.camera.near = 13;
    sunLight.shadow.camera.far = 320;
    sunLight.shadow.bias = -0.0005;
    sunLight.shadow.normalBias = 0.4;
    sc.add(sunLight);

    return { ambient: ambient, sunLight: sunLight };
  }

  var lighting = buildLighting(scene);

  /* ---------- 星空背景（模块 5：buildStarField） ---------- */

  /* 6000 颗星，分布于半径 800~2000 的球壳内（theta/phi 球面随机），
     点云渲染、半透明白色微光，星空缓慢自转，
     每颗星独立闪烁（顶点色 + 正弦调制亮度）。
     返回 { points, update(dtMs), dispose() } */
  function buildStarField(sc) {
    var STAR_COUNT = 6000;   // 星星数量
    var R_MIN = 800;         // 球壳内半径
    var R_MAX = 2000;        // 球壳外半径
    var ROT_SPEED = 0.02;    // 自转速度（弧度/秒，缓慢）
    var TWINKLE_AMP = 0.45;  // 闪烁振幅
    var pos = new Float32Array(STAR_COUNT * 3);
    var col = new Float32Array(STAR_COUNT * 3);
    var base = new Float32Array(STAR_COUNT);    // 每颗星基础亮度
    var phase = new Float32Array(STAR_COUNT);   // 闪烁相位（弧度）
    var freq = new Float32Array(STAR_COUNT);    // 闪烁角速度（弧度/秒）
    var twinkleT = 0;         // 闪烁时间累加器（毫秒）
    var i, theta, phi, r, sinPhi;
    for (i = 0; i < STAR_COUNT; i++) {
      theta = Math.random() * TWO_PI;           // 经向角 [0, 2π)
      phi = Math.acos(2 * Math.random() - 1);   // 极角 [0, π]，球面均匀分布
      r = R_MIN + Math.random() * (R_MAX - R_MIN);
      sinPhi = Math.sin(phi);
      pos[i * 3] = r * sinPhi * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi);
      pos[i * 3 + 2] = r * sinPhi * Math.sin(theta);
      base[i] = 0.35 + Math.random() * 0.40;    // 基础亮度 0.35~0.75
      phase[i] = Math.random() * TWO_PI;        // 随机相位
      freq[i] = 0.6 + Math.random() * 2.4;      // 随机频率 0.6~3.0 rad/s
      col[i * 3] = base[i];
      col[i * 3 + 1] = base[i];
      col[i * 3 + 2] = base[i];
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    var colAttr = new THREE.Float32BufferAttribute(col, 3);
    geo.setAttribute('color', colAttr);
    var mat = new THREE.PointsMaterial({
      color: 0xffffff,          // 白色微光
      size: 1.5,
      sizeAttenuation: false,   // 像素级恒定大小
      vertexColors: true,       // 按顶点色渲染（每星独立闪烁）
      transparent: true,        // 半透明
      opacity: 0.7,
      depthWrite: false
    });
    var points = new THREE.Points(geo, mat);
    sc.add(points);
    return {
      points: points,
      update: function (dtMs) {
        if (!dtMs) return;
        points.rotation.y += ROT_SPEED * dtMs / 1000;
        /* 闪烁效果：亮度 = 基础 + 振幅 × sin(ωt + φ)，钳制在 [0.15, 1] */
        twinkleT += dtMs;
        var t = twinkleT / 1000;
        for (var i2 = 0; i2 < STAR_COUNT; i2++) {
          var b = base[i2] + TWINKLE_AMP * Math.sin(t * freq[i2] + phase[i2]);
          if (b < 0.15) b = 0.15;
          else if (b > 1) b = 1;
          col[i2 * 3] = b;
          col[i2 * 3 + 1] = b;
          col[i2 * 3 + 2] = b;
        }
        colAttr.needsUpdate = true;
      },
      dispose: function () {
        geo.dispose();
        mat.dispose();
      }
    };
  }

  var starField = buildStarField(scene);

  /* ---------- 太阳与光晕（模块 6：buildSun） ---------- */

  /* Canvas 2D 径向渐变 → 光晕贴图 */
  function makeGlowTexture(inner, outer) {
    var c = document.createElement('canvas');
    c.width = c.height = 256;
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, inner);
    g.addColorStop(0.35, inner);
    g.addColorStop(0.6, outer);
    g.addColorStop(1, 'rgba(255,140,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    var tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  /* 太阳表面纹理：狂暴、沸腾、粘稠且流动的等离子体——
     核心（盘面中心/赤道）刺眼纯白 + 耀眼金黄，向边缘渐变成橙红/赤红（熔岩沸腾）；
     米粒组织：密密麻麻、大小不一的发光颗粒（锅中沸腾的气泡）；
     日珥：边缘（顶/底部边缘带）红色火焰珠链弧，中部亮、两端渐细消散；
     太阳黑子：深色斑点（比周围温度低，发光球上的黑色暗疮）。
     返回 THREE.CanvasTexture */
  function makeSunTexture(size) {
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');

    var i, x, y, r;

    /* 底色：盘面中心（赤道）刺眼白热 → 上下边缘橙红/赤红 */
    var base = ctx.createLinearGradient(0, 0, 0, size);
    base.addColorStop(0, '#f4511e');
    base.addColorStop(0.25, '#ff8c2e');
    base.addColorStop(0.45, '#ffc966');
    base.addColorStop(0.5, '#fffbe8');
    base.addColorStop(0.55, '#ffc966');
    base.addColorStop(0.75, '#ff8c2e');
    base.addColorStop(1, '#f4511e');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);

    /* 米粒组织：密密麻麻、大小不一的发光颗粒（沸腾气泡） */
    for (i = 0; i < 520; i++) {
      x = Math.random() * size;
      y = size * (0.08 + Math.random() * 0.84);
      r = 1 + Math.random() * 6;
      var g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,244,200,' + (0.18 + Math.random() * 0.22) + ')');
      g.addColorStop(0.75, 'rgba(255,200,110,' + (0.08 + Math.random() * 0.1) + ')');
      g.addColorStop(1, 'rgba(190,80,20,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TWO_PI);
      ctx.fill();
    }

    /* 沸腾气泡：稀疏、更亮更大的气泡（沸腾的等离子体翻涌） */
    for (i = 0; i < 130; i++) {
      x = Math.random() * size;
      y = size * (0.08 + Math.random() * 0.84);
      r = 1.5 + Math.random() * 6;
      var gb = ctx.createRadialGradient(x, y, 0, x, y, r);
      gb.addColorStop(0, 'rgba(255,250,222,' + (0.3 + Math.random() * 0.35) + ')');
      gb.addColorStop(0.6, 'rgba(255,214,140,' + (0.12 + Math.random() * 0.14) + ')');
      gb.addColorStop(1, 'rgba(255,190,100,0)');
      ctx.fillStyle = gb;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TWO_PI);
      ctx.fill();
    }

    /* 沸腾条纹：粘稠流动的岩浆（明暗交替翻滚） */
    for (i = 0; i < 64; i++) {
      var sy = size * (0.08 + Math.random() * 0.84);
      var amp = size * (0.003 + Math.random() * 0.012);
      var k = 1 + Math.floor(Math.random() * 4);
      var ph = Math.random() * TWO_PI;
      ctx.strokeStyle = Math.random() < 0.5
        ? 'rgba(255,238,180,' + (0.08 + Math.random() * 0.14) + ')'
        : 'rgba(205,75,20,' + (0.08 + Math.random() * 0.14) + ')';
      ctx.lineWidth = size * (0.002 + Math.random() * 0.01);
      ctx.lineCap = 'round';
      ctx.beginPath();
      var step = size / 256, first = true;
      for (x = 0; x <= size + step / 2; x += step) {
        y = sy + amp * Math.sin((x / size) * TWO_PI * k + ph);
        if (first) { ctx.moveTo(x, y); first = false; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    /* 日珥：边缘红色火焰珠链弧（顶部/底部边缘带 ≈ 盘面边缘）——
       重叠发光珠沿弧排列，中部亮、两端渐细消散，弧顶火核最亮 */
    var PROMS = 3, pi2;
    for (pi2 = 0; pi2 < PROMS; pi2++) {
      var isTop = pi2 % 2 === 0;
      var edgeY = isTop
        ? size * (0.02 + Math.random() * 0.03)
        : size * (0.95 + Math.random() * 0.03);
      var bulge = (isTop ? 1 : -1) * size * (0.05 + Math.random() * 0.05); // 向盘面中心鼓起
      var arcCx = size * (0.25 + Math.random() * 0.5);
      var arcW = size * (0.1 + Math.random() * 0.12); // 半宽（避开左右接缝）
      var BEADS = 16, bi2;
      for (bi2 = 0; bi2 < BEADS; bi2++) {
        var tt = -1 + (bi2 / (BEADS - 1)) * 2;
        var taper = 0.45 + 0.55 * Math.cos(tt * Math.PI / 2);
        var bx = arcCx + tt * arcW;
        var by = edgeY + bulge * Math.cos(tt * Math.PI / 2);
        var br = (2 + Math.random() * 3) * taper;
        var gf = ctx.createRadialGradient(bx, by, 0, bx, by, br * 2);
        gf.addColorStop(0, bi2 % 2 === 0 ? 'rgba(255,90,42,0.85)' : 'rgba(255,176,96,0.85)');
        gf.addColorStop(0.5, 'rgba(255,90,42,0.4)');
        gf.addColorStop(1, 'rgba(255,90,42,0)');
        ctx.fillStyle = gf;
        ctx.beginPath();
        ctx.arc(bx, by, br * 2, 0, TWO_PI);
        ctx.fill();
      }
      /* 弧顶火核（最亮） */
      var apexY = edgeY + bulge;
      var ag = ctx.createRadialGradient(arcCx, apexY, 0, arcCx, apexY, size * 0.02);
      ag.addColorStop(0, 'rgba(255,224,176,0.9)');
      ag.addColorStop(1, 'rgba(255,224,176,0)');
      ctx.fillStyle = ag;
      ctx.beginPath();
      ctx.arc(arcCx, apexY, size * 0.02, 0, TWO_PI);
      ctx.fill();
    }

    /* 太阳黑子：深色斑点（黑色暗疮）+ 略亮的半影 */
    for (i = 0; i < 4; i++) {
      var sx2 = size * (0.15 + Math.random() * 0.7);
      var sy2 = size * (0.2 + Math.random() * 0.6);
      var sr = size * (0.008 + Math.random() * 0.016);
      var gs = ctx.createRadialGradient(sx2, sy2, 0, sx2, sy2, sr * 2);
      gs.addColorStop(0, 'rgba(25,8,4,0.92)');
      gs.addColorStop(0.5, 'rgba(70,22,8,0.6)');
      gs.addColorStop(0.8, 'rgba(150,60,20,0.25)');
      gs.addColorStop(1, 'rgba(200,100,40,0)');
      ctx.fillStyle = gs;
      ctx.beginPath();
      ctx.arc(sx2, sy2, sr * 2, 0, TWO_PI);
      ctx.fill();
    }

    /* 整体灼亮提亮 */
    ctx.fillStyle = 'rgba(255,246,225,0.07)';
    ctx.fillRect(0, 0, size, size);

    var tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  /* 耀斑贴图：耀眼闪光（白核 → 金 → 透明） */
  function makeFlareTexture() {
    var c = document.createElement('canvas');
    c.width = c.height = 128;
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(255,235,170,0.85)');
    g.addColorStop(0.6, 'rgba(255,160,60,0.35)');
    g.addColorStop(1, 'rgba(255,120,30,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }

  /* 随机单位方向（拒绝采样） */
  function randUnitDir() {
    var x, y, z, l;
    do {
      x = Math.random() * 2 - 1;
      y = Math.random() * 2 - 1;
      z = Math.random() * 2 - 1;
      l = x * x + y * y + z * z;
    } while (l > 1 || l < 1e-4);
    var inv = 1 / Math.sqrt(l);
    return { x: x * inv, y: y * inv, z: z * inv };
  }

  /* 太阳：完美球形（自身发光、无暗面、均匀明亮）
     + 表面沸腾等离子体纹理（米粒组织/黑子）
     + 银白色日冕（双层背面加色壳 + 喷射光流，毛茸茸向外扩张 + 呼吸脉动）
     + Sprite 光晕（AdditiveBlending）
     + 耀斑（Sprite 池随机爆发）
     （日珥火焰珠链弧已烘焙进球体纹理）
     太阳加入 solarGroup，并记录 userData.isSun 标识供点击检测。
     返回 { group, sun, glow, update(dtMs) } */
  function buildSun(data) {
    var group = new THREE.Group();
    group.name = 'solarGroup';

    var sun = new THREE.Mesh(
      new THREE.SphereGeometry(data.radius, 48, 48),
      new THREE.MeshBasicMaterial({ map: makeSunTexture(1024) })
    );
    sun.name = data.key;
    sun.userData = {
      isSun: true,
      key: data.key,
      name: data.name,
      type: data.type,
      info: data.info
    };
    group.add(sun);

    /* 日冕：两层银白色加色壳（向外发散的流动光晕，毛茸茸喷射张力） */
    var coronaA = new THREE.Mesh(
      new THREE.SphereGeometry(data.radius * 1.06, 48, 48),
      new THREE.MeshBasicMaterial({
        color: 0xdfe6ee, transparent: true, opacity: 0.16,
        side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    coronaA.name = 'coronaA';
    var coronaB = new THREE.Mesh(
      new THREE.SphereGeometry(data.radius * 1.14, 48, 48),
      new THREE.MeshBasicMaterial({
        color: 0xcfd8e4, transparent: true, opacity: 0.07,
        side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    coronaB.name = 'coronaB';
    sun.add(coronaA);
    sun.add(coronaB);

    var glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture('rgba(255,244,230,1)', 'rgba(255,170,80,0.5)'),
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    }));
    glow.scale.set(data.radius * 5.33, data.radius * 5.33, 1);
    sun.add(glow);

    /* 日珥：已烘焙进球体纹理（makeSunTexture 的顶部/底部边缘火焰珠链弧，
       极区在大多数视角下位于盘面边缘）；此处不再使用 3D 几何 */

    /* 日冕光流：银白色短射线向外喷射——随机生成：
       方向/长度/寿命均随机；淡入 → 淡出，结束后重新随机再生（不断涌现的喷射活动） */
    var UPV = new THREE.Vector3(0, 1, 0);
    var _tmpV = new THREE.Vector3();
    var rays = [];
    function initRay(r) {
      var dd = randUnitDir();
      r.dir = new THREE.Vector3(dd.x, dd.y, dd.z);
      r.len = data.radius * (0.12 + Math.random() * 0.15); // 很短：贴近日面的短促喷射
      r.t = 0;
      r.life = 1.2 + Math.random() * 2.5;
      if (r.mesh) r.mesh.material.opacity = 0; // 重生瞬间不可见，避免残留上一段亮度
    }
    var ri;
    for (ri = 0; ri < 8; ri++) {
      var ray = new THREE.Mesh(
        new THREE.ConeGeometry(data.radius * 0.06, 1, 8, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0xdfe6ee, transparent: true, opacity: 0,
          side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false
        })
      );
      ray.name = 'coronaRay' + ri;
      sun.add(ray);
      var rec = { mesh: ray, dir: null, len: 1, t: 0, life: 1 };
      rays.push(rec);
      initRay(rec);
      rec.t = Math.random() * rec.life; // 随机初始相位（寿命错开）
    }

    /* 耀斑：瞬间爆发的耀眼闪光（Sprite 池，随机触发：扩展 + 变亮 → 淡出） */
    var flareTex = makeFlareTexture();
    var flares = [];
    var fi;
    for (fi = 0; fi < 4; fi++) {
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: flareTex, color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      sp.visible = false;
      sp.scale.setScalar(0.001);
      sun.add(sp);
      flares.push({ sp: sp, t: 0, life: 1, active: false });
    }
    var nextFlare = 1.5 + Math.random() * 3;

    /* 日冕呼吸脉动 + 耀斑生命周期 */
    var pulseT = 0;
    function update(dtMs) {
      if (!dtMs) return;
      var dt = dtMs / 1000;

      /* 日冕：不断向周围膨胀的呼吸张力 */
      pulseT += dt;
      var pu = 1 + 0.025 * Math.sin(pulseT * 1.4);
      coronaA.scale.setScalar(pu);
      coronaB.scale.setScalar(1 + 0.035 * Math.sin(pulseT * 1.4 - 0.6));
      glow.scale.set(data.radius * 5.33 * pu, data.radius * 5.33 * pu, 1);

      /* 日冕光流：随机生命周期（淡入 → 淡出 → 重新随机再生） */
      var ri2;
      for (ri2 = 0; ri2 < rays.length; ri2++) {
        var rr = rays[ri2];
        rr.t += dt;
        if (rr.t >= rr.life) {
          initRay(rr); // 重新随机生成（新方向/长度/寿命）
          continue;
        }
        var rp = rr.t / rr.life;
        var env = Math.sin(Math.PI * rp); // 0 → 1 → 0
        rr.mesh.material.opacity = 0.12 * env;
        /* 锥尖(+Y)朝内（贴日面），底面在外 → 向外张开的喷射感 */
        rr.mesh.quaternion.setFromUnitVectors(UPV, _tmpV.copy(rr.dir).multiplyScalar(-1));
        rr.mesh.scale.set(1, rr.len, 1);
        rr.mesh.position.copy(rr.dir).multiplyScalar(data.radius * 0.98 + rr.len * 0.5);
      }

      /* 耀斑：寿命推进（快速扩展 + 亮 → 淡出回收） */
      var j;
      for (j = 0; j < flares.length; j++) {
        var fl = flares[j];
        if (!fl.active) continue;
        fl.t += dt;
        var p = fl.t / fl.life;
        if (p >= 1) {
          fl.active = false;
          fl.sp.visible = false;
          fl.sp.material.opacity = 0;
          continue;
        }
        fl.sp.scale.setScalar(data.radius * (0.4 + 1.9 * p));
        fl.sp.material.opacity = (p < 0.25 ? p / 0.25 : 1 - (p - 0.25) / 0.75) * 0.9;
      }

      /* 随机触发耀斑（1.5~6 秒一次） */
      nextFlare -= dt;
      if (nextFlare <= 0) {
        nextFlare = 1.5 + Math.random() * 4.5;
        var free = null;
        for (j = 0; j < flares.length; j++) {
          if (!flares[j].active) { free = flares[j]; break; }
        }
        if (free) {
          var dd = randUnitDir();
          free.sp.position.set(dd.x, dd.y, dd.z).multiplyScalar(data.radius * 1.02);
          free.t = 0;
          free.life = 0.9 + Math.random() * 0.8;
          free.active = true;
          free.sp.visible = true;
        }
      }
    }

    return { group: group, sun: sun, glow: glow, update: update };
  }

  if (typeof window.SOLAR_DATA === 'undefined' || !window.SOLAR_DATA.sun) {
    showFatal('window.SOLAR_DATA 未定义（js/data.js 未加载）');
    return;
  }

  var sunBuild = buildSun(window.SOLAR_DATA.sun);
  var solarGroup = sunBuild.group;
  var sun = sunBuild.sun;
  var sunUpdate = sunBuild.update; // 日冕脉动 + 耀斑（太阳自身能量驱动，不随模拟暂停）
  scene.add(solarGroup);

  /* ---------- 行星与月球（模块 8：buildPlanets / buildMoon） ---------- */

  /* 圆形轨道线（XZ 平面）：THREE.Line + LineBasicMaterial */
  function makeOrbitCircle(radius, color, opacity) {
    var N = 256, i;
    var arr = new Float32Array((N + 1) * 3);
    for (i = 0; i <= N; i++) {
      var a = (i / N) * TWO_PI;
      arr[i * 3] = Math.cos(a) * radius;
      arr[i * 3 + 1] = 0;
      arr[i * 3 + 2] = Math.sin(a) * radius;
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    var mat = new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: opacity });
    return new THREE.Line(geo, mat);
  }

  /* 月球：球体网格 + 月球组（moonGroup 旋转实现绕地公转）+ 月球轨道线。
     月球轨道线挂在行星组下随行星移动。
     返回 { group, mesh, orbitLine } */
  function buildMoon(data, parent) {
    var group = new THREE.Group();
    group.name = 'moonOrbit:' + data.key;

    var mesh = new THREE.Mesh(
      new THREE.SphereGeometry(data.radius, 24, 24),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(data.color), roughness: 0.9, metalness: 0.05
      })
    );
    mesh.name = data.key;
    mesh.position.x = data.orbitRadius;
    mesh.userData = {
      isSun: false, isMoon: true,
      key: data.key, name: data.name, type: data.type,
      period: data.period, orbitRadius: data.orbitRadius, info: data.info
    };
    group.add(mesh);

    /* 月球轨道线（挂在行星组下随行星移动） */
    var orbitLine = makeOrbitCircle(data.orbitRadius, 0x8899bb, 0.35);
    orbitLine.name = 'moonOrbitLine:' + data.key;
    parent.add(orbitLine);

    parent.add(group);
    return { data: data, group: group, mesh: mesh, orbitLine: orbitLine };
  }

  /* ---------- 水星表面纹理（程序化 Canvas 贴图） ---------- */

  /* 水星：整体冷峻的灰白色调，冰冷、坚硬的金属/岩石质感；
     质地极其粗糙、斑驳，表面布满大小不一、深浅不一的碗状凹陷（环形山/陨石坑）——
     坑底有深灰色阴影（径向渐变、中心最深），边缘有微弱亮光（"坑坑洼洼"）。
     球形轮廓保持不变（仅表面着色），返回 THREE.CanvasTexture */
  function makeMercuryTexture(size) {
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');

    /* 基底：冷峻灰白（偏冷色调的岩石） */
    ctx.fillStyle = '#9aa0a8';
    ctx.fillRect(0, 0, size, size);

    var i, x, y, r, g;

    /* 斑驳：大面积明暗斑块（低频，粗糙感） */
    for (i = 0; i < 240; i++) {
      x = Math.random() * size;
      y = Math.random() * size;
      r = size * (0.02 + Math.random() * 0.08);
      ctx.fillStyle = Math.random() > 0.5
        ? 'rgba(212,216,222,' + (0.03 + Math.random() * 0.05) + ')'
        : 'rgba(88,93,103,' + (0.03 + Math.random() * 0.05) + ')';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TWO_PI);
      ctx.fill();
    }

    /* 细碎颗粒：极粗糙岩石颗粒感 */
    for (i = 0; i < 900; i++) {
      x = Math.random() * size;
      y = Math.random() * size;
      r = 0.5 + Math.random() * 1.8;
      g = Math.random();
      ctx.fillStyle = g > 0.5
        ? 'rgba(222,226,232,' + (0.04 + Math.random() * 0.06) + ')'
        : 'rgba(78,82,92,' + (0.04 + Math.random() * 0.06) + ')';
      ctx.fillRect(x, y, r, r);
    }

    /* 环形山（陨石坑）：大小不一、深浅不一的碗状凹陷
       坑底：深灰色阴影（径向渐变，中心最深）；
       边缘：微弱亮光（细环 + 一侧亮弧，模拟坑缘受光） */
    for (i = 0; i < 90; i++) {
      x = Math.random() * size;
      y = Math.random() * size;
      r = size * (0.008 + Math.random() * 0.055); // 直径：细小 → 大碗状

      /* 碗状凹陷：径向渐变（坑底深灰 → 边缘融入基底） */
      var bowl = ctx.createRadialGradient(x, y, r * 0.1, x, y, r);
      bowl.addColorStop(0, 'rgba(56,60,68,0.85)');
      bowl.addColorStop(0.55, 'rgba(82,86,96,0.55)');
      bowl.addColorStop(0.82, 'rgba(116,120,130,0.28)');
      bowl.addColorStop(1, 'rgba(154,160,168,0)');
      ctx.fillStyle = bowl;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TWO_PI);
      ctx.fill();

      /* 坑缘微弱亮光：完整细环 */
      ctx.strokeStyle = 'rgba(234,238,244,' + (0.14 + Math.random() * 0.2) + ')';
      ctx.lineWidth = Math.max(1, r * 0.09);
      ctx.beginPath();
      ctx.arc(x, y, r * 0.92, 0, TWO_PI);
      ctx.stroke();

      /* 亮弧：坑缘一侧受光更明显 */
      ctx.strokeStyle = 'rgba(250,252,255,' + (0.22 + Math.random() * 0.28) + ')';
      ctx.lineWidth = Math.max(1, r * 0.07);
      ctx.beginPath();
      ctx.arc(x, y, r * 0.95, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
    }

    var tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  /* ---------- 金星表面纹理（程序化 Canvas 贴图） ---------- */

  /* 金星：表面极其光滑，无环形山/高山等岩石起伏；质感偏流动液体/浓密气体，柔软、雾蒙蒙。
     底色奶白/奶油/浅米，局部浅橙、黄褐、暗红褐；
     核心特征（云层）：柔软弯曲的带状云雾，斜向"V"/波浪形交织（奶油拉花/大理石/丝绸水流），
     深色黄褐斑块如水彩晕染、边缘朦胧无清晰界限。
     水平方向整数波数保证左右无缝；带状/拉花/斑块均做边缘环绕复制。
     球形轮廓保持不变（仅表面着色），返回 THREE.CanvasTexture */
  function makeVenusTexture(size) {
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');

    /* 色板：奶白 / 奶油 / 浅米 / 浅橙 / 黄褐 / 暗红褐 */
    var PALETTE = [
      '255,252,244', '240,224,192', '228,196,148',
      '224,178,118', '186,138,79', '142,88,52'
    ];
    function rgba(c, a) { return 'rgba(' + c + ',' + a + ')'; }

    var i, x, y, t;

    /* 底色：奶白 → 奶油 → 浅米 的柔和纵向渐变 */
    var base = ctx.createLinearGradient(0, 0, 0, size);
    base.addColorStop(0, '#f5efe2');
    base.addColorStop(0.45, '#efe3cc');
    base.addColorStop(0.75, '#ead9b8');
    base.addColorStop(1, '#f2e9d8');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);

    /* 带状云雾：柔软正弦带（整数波数 → 左右无缝），
       不同相位/振幅的波相互交织成 V/波浪形流动；上下边缘环绕复制 */
    var b, y0, amp, k, ph, th, yy;
    for (b = 0; b < 26; b++) {
      y0 = Math.random() * size;
      amp = size * (0.015 + Math.random() * 0.045);
      k = 1 + Math.floor(Math.random() * 3);   // 整数波数 1~3
      ph = Math.random() * TWO_PI;
      th = size * (0.02 + Math.random() * 0.05);
      var bandCol = PALETTE[b % PALETTE.length];
      var bandA = 0.05 + Math.random() * 0.10; // 低不透明度 → 柔软

      for (yy = -1; yy <= 1; yy++) {
        ctx.strokeStyle = rgba(bandCol, bandA);
        ctx.lineWidth = th;
        ctx.lineCap = 'round';
        ctx.beginPath();
        var step = size / 256, first = true;
        for (x = 0; x <= size + step / 2; x += step) {
          y = y0 + yy * size + amp * Math.sin((x / size) * TWO_PI * k + ph);
          if (first) { ctx.moveTo(x, y); first = false; }
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    /* 拉花/大理石流纹：大尺度柔和波浪椭圆环（丝绸在水流中扭曲），左右边缘环绕复制 */
    function swirl(cx, cy, rx, ry, rot, wav, ph2, color, width) {
      var off, px, py, ca = Math.cos(rot), sa = Math.sin(rot), ang, w, lx, ly;
      for (off = -1; off <= 1; off++) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        for (t = 0; t <= 72; t++) {
          ang = (t / 72) * TWO_PI;
          w = 1 + wav * Math.sin(ang * 3 + ph2);   // 波浪扰动 → 拉花感
          lx = Math.cos(ang) * rx * w;
          ly = Math.sin(ang) * ry * w;
          px = cx + off * size + lx * ca - ly * sa;
          py = cy + lx * sa + ly * ca;
          if (t === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      }
    }

    for (i = 0; i < 24; i++) {
      swirl(
        Math.random() * size,
        Math.random() * size,
        size * (0.12 + Math.random() * 0.30),
        size * (0.02 + Math.random() * 0.07),
        -0.5 + Math.random() * 1.0,
        0.15 + Math.random() * 0.25,
        Math.random() * TWO_PI,
        rgba(PALETTE[2 + Math.floor(Math.random() * 4)], 0.04 + Math.random() * 0.05),
        size * (0.008 + Math.random() * 0.025)
      );
    }

    /* 朦胧斑块：黄褐/暗红褐如水彩晕染（径向渐变、边缘无清晰界限），左右边缘环绕复制 */
    for (i = 0; i < 16; i++) {
      var bx = Math.random() * size;
      var by = Math.random() * size;
      var br = size * (0.06 + Math.random() * 0.12);
      var hcol = PALETTE[3 + (i % 3)];
      var hab = 0.10 + Math.random() * 0.14;
      var off2;
      for (off2 = -1; off2 <= 1; off2++) {
        var grad = ctx.createRadialGradient(bx + off2 * size, by, 0, bx + off2 * size, by, br);
        grad.addColorStop(0, rgba(hcol, hab));
        grad.addColorStop(0.6, rgba(hcol, hab * 0.45));
        grad.addColorStop(1, rgba(hcol, 0));
        ctx.fillStyle = grad;
        ctx.fillRect(bx + off2 * size - br, by - br, br * 2, br * 2);
      }
    }

    /* 整体朦胧：雾蒙蒙的薄纱（上层白色薄雾 + 下层奶油色晕） */
    var mist = ctx.createLinearGradient(0, 0, 0, size);
    mist.addColorStop(0, 'rgba(255,253,248,0.18)');
    mist.addColorStop(0.5, 'rgba(255,250,240,0.06)');
    mist.addColorStop(1, 'rgba(240,225,200,0.16)');
    ctx.fillStyle = mist;
    ctx.fillRect(0, 0, size, size);

    var tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  /* ---------- 火星表面纹理（程序化 Canvas 贴图） ---------- */

  /* 火星：底色深邃铁锈红、赤橙、土黄与暗褐交织，如风化了亿万年的巨大生锈铁块；
     质感干涸粗糙、布满粉尘砂砾（极度干旱的荒漠戈壁、无水汽的坚硬岩石感）；
     核心特征：
     极地冰盖——球体顶/底两块纯白区域（两顶白帽，与红色表面强冷暖对比）；
     斑驳明暗区域——深褐（古老火山岩平原）与亮红橙（沙尘高地）水彩晕染、分布极不均匀；
     坑洼与裂痕——大小不一的环形山（较水星稀疏）、长条暗纹（峡谷）、圆形凸起（火山）。
     球形轮廓保持不变（仅表面着色），返回 THREE.CanvasTexture */
  function makeMarsTexture(size) {
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');

    /* 色板：铁锈红 / 赤橙 / 土黄 / 暗褐 / 亮锈 */
    var RUST = ['164,80,44', '201,106,53', '201,141,74', '110,58,34', '184,96,58'];
    function rgba(c, a) { return 'rgba(' + c + ',' + a + ')'; }
    /* 左右边缘环绕复制（贴图水平无缝） */
    function wrap3(draw) { var o; for (o = -1; o <= 1; o++) draw(o * size); }

    var i, x, y, r;

    /* 底色：深邃铁锈红 */
    ctx.fillStyle = '#a4502c';
    ctx.fillRect(0, 0, size, size);

    /* 斑驳明暗区域：大片深褐（古老火山岩平原）/ 亮红橙（沙尘高地），水彩晕染 */
    for (i = 0; i < 24; i++) {
      var bx = Math.random() * size;
      var by = size * (0.15 + Math.random() * 0.7); // 避开两极冰盖
      var br = size * (0.08 + Math.random() * 0.14);
      var dark = Math.random() < 0.5;
      var cc = dark ? '80,42,25' : '210,140,85';
      var ca = dark ? (0.12 + Math.random() * 0.13) : (0.10 + Math.random() * 0.12);
      wrap3(function (off) {
        var g = ctx.createRadialGradient(bx + off, by, 0, bx + off, by, br);
        g.addColorStop(0, rgba(cc, ca));
        g.addColorStop(0.6, rgba(cc, ca * 0.5));
        g.addColorStop(1, rgba(cc, 0));
        ctx.fillStyle = g;
        ctx.fillRect(bx + off - br, by - br, br * 2, br * 2);
      });
    }

    /* 斑驳色块：铁锈红/赤橙/土黄/暗褐交织（色彩分布极不均匀） */
    for (i = 0; i < 220; i++) {
      x = Math.random() * size;
      y = Math.random() * size;
      r = size * (0.015 + Math.random() * 0.07);
      ctx.fillStyle = rgba(RUST[Math.floor(Math.random() * RUST.length)], 0.04 + Math.random() * 0.08);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TWO_PI);
      ctx.fill();
    }

    /* 粉尘与砂砾：干涸粗糙颗粒感（极度干旱的荒漠戈壁） */
    for (i = 0; i < 1400; i++) {
      x = Math.random() * size;
      y = Math.random() * size;
      var gr = 0.5 + Math.random() * 1.6;
      ctx.fillStyle = Math.random() > 0.5
        ? 'rgba(226,170,120,' + (0.05 + Math.random() * 0.07) + ')'
        : 'rgba(96,52,32,' + (0.05 + Math.random() * 0.08) + ')';
      ctx.fillRect(x, y, gr, gr);
    }

    /* 环形山：大小不一的碗状凹陷（较水星稀疏）+ 微弱坑缘亮光 */
    for (i = 0; i < 38; i++) {
      x = Math.random() * size;
      y = size * (0.12 + Math.random() * 0.76);
      r = size * (0.006 + Math.random() * 0.038);
      var rimA = 0.1 + Math.random() * 0.12;
      wrap3(function (off) {
        var g = ctx.createRadialGradient(x + off, y, r * 0.15, x + off, y, r);
        g.addColorStop(0, 'rgba(88,46,28,0.8)');
        g.addColorStop(0.55, 'rgba(118,66,40,0.5)');
        g.addColorStop(1, 'rgba(164,80,44,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x + off, y, r, 0, TWO_PI);
        ctx.fill();
        ctx.strokeStyle = rgba('232,182,132', rimA);
        ctx.lineWidth = Math.max(1, r * 0.08);
        ctx.beginPath();
        ctx.arc(x + off, y, r * 0.94, 0, TWO_PI);
        ctx.stroke();
      });
    }

    /* 峡谷：长条形暗纹（如大裂谷），带微弱亮缘（裂痕高光） */
    for (i = 0; i < 7; i++) {
      var sx = Math.random() * size;
      var sy = size * (0.18 + Math.random() * 0.64);
      var len = size * (0.25 + Math.random() * 0.4);
      var ang = Math.random() * TWO_PI;
      var seg = 6 + Math.floor(Math.random() * 5);
      var pts = [[sx, sy]];
      for (var s2 = 1; s2 <= seg; s2++) {
        var frac = s2 / seg;
        pts.push([
          sx + Math.cos(ang) * len * frac + (Math.random() - 0.5) * len * 0.3,
          sy + Math.sin(ang) * len * frac * 0.6 + (Math.random() - 0.5) * len * 0.35
        ]);
      }
      wrap3(function (off) {
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (var q = 0; q < pts.length; q++) {
          if (q === 0) ctx.moveTo(pts[q][0] + off, pts[q][1]);
          else ctx.lineTo(pts[q][0] + off, pts[q][1]);
        }
        ctx.strokeStyle = 'rgba(84,42,24,0.35)';
        ctx.lineWidth = Math.max(1.5, size * 0.004);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(226,170,120,0.12)';
        ctx.lineWidth = Math.max(1, size * 0.0015);
        ctx.stroke();
      });
    }

    /* 火山：巨大圆形凸起（中心较亮、边缘暗影、中央火山口） */
    for (i = 0; i < 3; i++) {
      x = Math.random() * size;
      y = size * (0.2 + Math.random() * 0.6);
      r = size * (0.09 + Math.random() * 0.09);
      wrap3(function (off) {
        var g = ctx.createRadialGradient(x + off, y, 0, x + off, y, r);
        g.addColorStop(0, 'rgba(196,128,78,0.55)');
        g.addColorStop(0.7, 'rgba(150,84,48,0.35)');
        g.addColorStop(1, 'rgba(110,58,34,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x + off, y, r, 0, TWO_PI);
        ctx.fill();
        /* 中央火山口 */
        ctx.fillStyle = 'rgba(72,36,20,0.55)';
        ctx.beginPath();
        ctx.arc(x + off, y, r * 0.16, 0, TWO_PI);
        ctx.fill();
      });
    }

    /* 尘埃薄纱：淡红橙色大气尘（干涸、无水汽） */
    var dust = ctx.createLinearGradient(0, 0, 0, size);
    dust.addColorStop(0, 'rgba(190,110,66,0.10)');
    dust.addColorStop(0.5, 'rgba(200,120,72,0.06)');
    dust.addColorStop(1, 'rgba(190,110,66,0.10)');
    ctx.fillStyle = dust;
    ctx.fillRect(0, 0, size, size);

    /* 极地冰盖：顶/底两块纯白"白帽"（与红色表面强冷暖对比），边缘柔和 */
    var capH = size * 0.12;
    var capTop = ctx.createLinearGradient(0, 0, 0, capH);
    capTop.addColorStop(0, 'rgba(240,246,252,0.95)');
    capTop.addColorStop(0.55, 'rgba(238,244,250,0.65)');
    capTop.addColorStop(1, 'rgba(238,244,250,0)');
    ctx.fillStyle = capTop;
    ctx.fillRect(0, 0, size, capH);

    var capBot = ctx.createLinearGradient(0, size, 0, size - capH);
    capBot.addColorStop(0, 'rgba(240,246,252,0.95)');
    capBot.addColorStop(0.55, 'rgba(238,244,250,0.65)');
    capBot.addColorStop(1, 'rgba(238,244,250,0)');
    ctx.fillStyle = capBot;
    ctx.fillRect(0, size - capH, size, capH);

    /* 冰盖边缘斑驳：白色斑点（帽缘参差），左右环绕 */
    for (i = 0; i < 14; i++) {
      var ix = Math.random() * size;
      var iy = Math.random() < 0.5
        ? Math.random() * capH * 0.8
        : size - Math.random() * capH * 0.8;
      var ir = size * (0.02 + Math.random() * 0.05);
      var ia = 0.15 + Math.random() * 0.2;
      wrap3(function (off) {
        var g = ctx.createRadialGradient(ix + off, iy, 0, ix + off, iy, ir);
        g.addColorStop(0, 'rgba(244,248,252,' + ia + ')');
        g.addColorStop(1, 'rgba(244,248,252,0)');
        ctx.fillStyle = g;
        ctx.fillRect(ix + off - ir, iy - ir, ir * 2, ir * 2);
      });
    }

    var tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  /* ---------- 木星表面纹理（程序化 Canvas 贴图） ---------- */

  /* 木星：无岩石/陨石坑/山脉，表面极其光滑、流畅、粘稠且流动——
     如不同颜色油画颜料倒在水面被风吹拂拉扯出的混色纹理（拉丝太妃糖）；
     底色奶白/米黄/浅棕交织，红褐、赤橙、灰褐横向拉长分布；
     核心特征：
     平行条纹——与赤道平行的横向带状纹理，如海浪翻滚交织，边缘波浪/漩涡状扭动；
     大红斑——醒目的橙红色大椭圆，轮廓清晰、色彩深浅晕染（深邃红宝石）；
     白色风暴——云带中点缀亮白色圆润小椭圆（风暴气旋，漂浮的白扁舟）。
     水平方向整数波数保证左右无缝，球形轮廓保持不变。返回 THREE.CanvasTexture */
  function makeJupiterTexture(size) {
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');

    /* 色板：奶白 / 米黄 / 浅棕 / 红褐 / 赤橙 / 灰褐 */
    var JPAL = [
      '242,234,216', '232,213,174', '200,160,106',
      '164,85,58', '201,106,53', '138,117,98'
    ];
    function rgba(c, a) { return 'rgba(' + c + ',' + a + ')'; }

    var i, b, x, y;

    /* 底色：奶白 → 米黄 → 浅棕 柔和纵向渐变 */
    var base = ctx.createLinearGradient(0, 0, 0, size);
    base.addColorStop(0, '#e9e2d0');
    base.addColorStop(0.4, '#e8d5ae');
    base.addColorStop(0.7, '#d9bd93');
    base.addColorStop(1, '#e5d9c2');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);

    /* 平行条纹：与赤道平行的横向带状纹理（波浪上下缘 → 海浪翻滚交织），
       整数波数 → 左右无缝 */
    function wavyBand(yc, ht, amp, k, p1, p2, fill) {
      var step = size / 256, x2, y2, first = true;
      ctx.beginPath();
      for (x2 = 0; x2 <= size + step / 2; x2 += step) {
        y2 = yc - ht + amp * Math.sin((x2 / size) * TWO_PI * k + p1);
        if (first) { ctx.moveTo(x2, y2); first = false; }
        else ctx.lineTo(x2, y2);
      }
      first = true;
      for (x2 = size; x2 >= -step / 2; x2 -= step) {
        y2 = yc + ht + amp * Math.sin((x2 / size) * TWO_PI * k + p2);
        if (first) { ctx.lineTo(x2, y2); first = false; }
        else ctx.lineTo(x2, y2);
      }
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }

    var NB = 14;
    for (b = 0; b < NB; b++) {
      var yc = (b + 0.5) * (size / NB) + (Math.random() - 0.5) * (size / NB) * 0.5;
      var ht = (size / NB) * (0.28 + Math.random() * 0.3);
      var amp = size * (0.006 + Math.random() * 0.02);   // 波浪状边缘扭动
      var k = 1 + Math.floor(Math.random() * 3);
      var p1 = Math.random() * TWO_PI;
      var p2 = p1 + Math.random() * 1.5;                  // 上下缘异相 → 交织感
      var col = JPAL[b % JPAL.length];
      wavyBand(yc, ht, amp, k, p1, p2, rgba(col, 0.5 + Math.random() * 0.32));
    }

    /* 油画拉丝：细薄横向波纹（颜料被风吹拂拉扯的混色纹理） */
    for (i = 0; i < 64; i++) {
      var sy = Math.random() * size;
      var amp2 = size * (0.004 + Math.random() * 0.014);
      var k2 = 2 + Math.floor(Math.random() * 5);
      var ph2 = Math.random() * TWO_PI;
      ctx.strokeStyle = rgba(JPAL[Math.floor(Math.random() * JPAL.length)], 0.05 + Math.random() * 0.09);
      ctx.lineWidth = size * (0.003 + Math.random() * 0.012);
      ctx.lineCap = 'round';
      ctx.beginPath();
      var step2 = size / 256, first2 = true;
      for (x = 0; x <= size + step2 / 2; x += step2) {
        y = sy + amp2 * Math.sin((x / size) * TWO_PI * k2 + ph2);
        if (first2) { ctx.moveTo(x, y); first2 = false; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    /* 条带边缘小漩涡（剪切涡，漩涡状扭动感） */
    for (i = 0; i < 20; i++) {
      var vx = Math.random() * size;
      var vy = Math.random() * size;
      var rx = size * (0.02 + Math.random() * 0.05);
      var ry = size * (0.006 + Math.random() * 0.016);
      var rot = (Math.random() - 0.5) * 0.6;
      var pv = Math.random() * TWO_PI;
      var ca = Math.cos(rot), sa = Math.sin(rot);
      ctx.strokeStyle = rgba(JPAL[Math.floor(Math.random() * JPAL.length)], 0.10 + Math.random() * 0.12);
      ctx.lineWidth = Math.max(1, size * 0.003);
      ctx.beginPath();
      for (var iv = 0; iv <= 40; iv++) {
        var a3 = (iv / 40) * TWO_PI;
        var w3 = 1 + 0.3 * Math.sin(a3 * 2 + pv);
        var lx3 = Math.cos(a3) * rx * w3;
        var ly3 = Math.sin(a3) * ry * w3;
        var px3 = vx + lx3 * ca - ly3 * sa;
        var py3 = vy + lx3 * sa + ly3 * ca;
        if (iv === 0) ctx.moveTo(px3, py3);
        else ctx.lineTo(px3, py3);
      }
      ctx.closePath();
      ctx.stroke();
    }

    /* 大红斑：醒目橙红色大椭圆——轮廓清晰、色彩深浅晕染（镶嵌条纹间的红宝石） */
    var gx = size * 0.66;   // 画面偏右上
    var gy = size * 0.36;
    var grx = size * 0.085;
    var gry = size * 0.05;

    /* 外围光晕（色彩晕染） */
    ctx.save();
    ctx.translate(gx, gy);
    ctx.scale(1, gry / grx);
    var glow = ctx.createRadialGradient(0, 0, grx * 0.3, 0, 0, grx * 1.5);
    glow.addColorStop(0, 'rgba(198,92,48,0.35)');
    glow.addColorStop(1, 'rgba(198,92,48,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, grx * 1.5, 0, TWO_PI);
    ctx.fill();
    ctx.restore();

    /* 主体：中心亮橙红 → 边缘深红褐 */
    ctx.save();
    ctx.translate(gx, gy);
    ctx.scale(1, gry / grx);
    var spot = ctx.createRadialGradient(-grx * 0.15, -gry * 0.1, grx * 0.1, 0, 0, grx);
    spot.addColorStop(0, 'rgba(226,132,80,0.96)');
    spot.addColorStop(0.55, 'rgba(192,88,48,0.94)');
    spot.addColorStop(1, 'rgba(148,58,34,0.88)');
    ctx.fillStyle = spot;
    ctx.beginPath();
    ctx.arc(0, 0, grx, 0, TWO_PI);
    ctx.fill();
    /* 深色轮廓（清晰边界） */
    ctx.strokeStyle = 'rgba(118,44,26,0.5)';
    ctx.lineWidth = Math.max(1.5, size * 0.002);
    ctx.stroke();
    /* 内部亮核（深浅晕染层次） */
    var core = ctx.createRadialGradient(-grx * 0.2, 0, 0, -grx * 0.2, 0, grx * 0.45);
    core.addColorStop(0, 'rgba(236,156,102,0.6)');
    core.addColorStop(1, 'rgba(236,156,102,0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(0, 0, grx, 0, TWO_PI);
    ctx.fill();
    ctx.restore();

    /* 白色风暴：亮白色圆润小椭圆（风暴气旋，漂浮在彩色河流上的白扁舟） */
    var nStorms = 7;
    for (i = 0; i < nStorms; i++) {
      var wx = size * (0.1 + Math.random() * 0.8); // 避开左右接缝
      var wy = size * (0.12 + Math.random() * 0.76);
      var wrx = size * (0.012 + Math.random() * 0.022);
      var wry = wrx * (0.45 + Math.random() * 0.3);
      var war = 0.85 + Math.random() * 0.1;
      /* 避免与大红斑重叠 */
      var ddx = wx - gx, ddy = (wy - gy) * (grx / gry);
      if (Math.sqrt(ddx * ddx + ddy * ddy) < grx * 1.8) continue;

      ctx.save();
      ctx.translate(wx, wy);
      ctx.scale(1, wry / wrx);
      var ws = ctx.createRadialGradient(0, 0, 0, 0, 0, wrx);
      ws.addColorStop(0, 'rgba(255,255,252,' + war + ')');
      ws.addColorStop(0.7, 'rgba(250,248,240,' + (war * 0.8) + ')');
      ws.addColorStop(1, 'rgba(245,240,228,0)');
      ctx.fillStyle = ws;
      ctx.beginPath();
      ctx.arc(0, 0, wrx, 0, TWO_PI);
      ctx.fill();
      /* 微弱暖色边缘（与云带融合） */
      ctx.strokeStyle = 'rgba(226,190,140,0.25)';
      ctx.lineWidth = Math.max(1, wrx * 0.08);
      ctx.stroke();
      ctx.restore();
    }

    /* 整体光泽：油画颜料的湿润反光（赤道附近更亮） */
    var sheen = ctx.createLinearGradient(0, 0, 0, size);
    sheen.addColorStop(0, 'rgba(255,250,238,0.05)');
    sheen.addColorStop(0.5, 'rgba(255,252,244,0.14)');
    sheen.addColorStop(1, 'rgba(255,250,238,0.05)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, size, size);

    var tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  /* ---------- 土星表面纹理（程序化 Canvas 贴图） ---------- */

  /* 土星：比木星更温柔淡雅——底色柔和的奶油白、淡黄、浅金棕色交替；
     流动气体，比木星更模糊、更柔和、更细腻的横向条纹；
     边缘带一层淡淡雾霭，非常宁静。
     水平方向整数波数保证左右无缝，球形轮廓保持不变（仅表面着色）。
     返回 THREE.CanvasTexture */
  function makeSaturnTexture(size) {
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');

    /* 柔和色板：奶油白 / 淡黄 / 浅金棕 / 柔褐 / 浅灰褐 */
    var SPAL = ['242,236,216', '232,220,176', '212,185,136', '194,162,118', '184,168,144'];
    function rgba(c, a) { return 'rgba(' + c + ',' + a + ')'; }

    var i, b, x, y;

    /* 底色：奶油白 → 淡黄 → 浅金棕 */
    var base = ctx.createLinearGradient(0, 0, 0, size);
    base.addColorStop(0, '#f2ecd8');
    base.addColorStop(0.45, '#e8dcb0');
    base.addColorStop(0.75, '#dcc496');
    base.addColorStop(1, '#eee4c8');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);

    /* 柔和横向条纹：低不透明度 + 小振幅波浪（比木星更模糊细腻） */
    function wavyBand(yc, ht, amp, k, p1, p2, fill) {
      var step = size / 256, x2, y2, first = true;
      ctx.beginPath();
      for (x2 = 0; x2 <= size + step / 2; x2 += step) {
        y2 = yc - ht + amp * Math.sin((x2 / size) * TWO_PI * k + p1);
        if (first) { ctx.moveTo(x2, y2); first = false; }
        else ctx.lineTo(x2, y2);
      }
      first = true;
      for (x2 = size; x2 >= -step / 2; x2 -= step) {
        y2 = yc + ht + amp * Math.sin((x2 / size) * TWO_PI * k + p2);
        if (first) { ctx.lineTo(x2, y2); first = false; }
        else ctx.lineTo(x2, y2);
      }
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }

    var NB = 16;
    for (b = 0; b < NB; b++) {
      var yc = (b + 0.5) * (size / NB) + (Math.random() - 0.5) * (size / NB) * 0.5;
      var ht = (size / NB) * (0.3 + Math.random() * 0.3);
      var amp = size * (0.003 + Math.random() * 0.01);
      var k = 1 + Math.floor(Math.random() * 2);
      var p1 = Math.random() * TWO_PI;
      var p2 = p1 + Math.random() * 1.2;
      wavyBand(yc, ht, amp, k, p1, p2, rgba(SPAL[b % SPAL.length], 0.2 + Math.random() * 0.24));
    }

    /* 细腻拉丝：极细横向波纹（柔和流动感） */
    for (i = 0; i < 48; i++) {
      var sy = Math.random() * size;
      var amp2 = size * (0.002 + Math.random() * 0.008);
      var k2 = 1 + Math.floor(Math.random() * 4);
      var ph2 = Math.random() * TWO_PI;
      ctx.strokeStyle = rgba(SPAL[Math.floor(Math.random() * SPAL.length)], 0.04 + Math.random() * 0.06);
      ctx.lineWidth = size * (0.002 + Math.random() * 0.008);
      ctx.lineCap = 'round';
      ctx.beginPath();
      var step2 = size / 256, first2 = true;
      for (x = 0; x <= size + step2 / 2; x += step2) {
        y = sy + amp2 * Math.sin((x / size) * TWO_PI * k2 + ph2);
        if (first2) { ctx.moveTo(x, y); first2 = false; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    /* 淡淡雾霭：柔和的宁静薄纱 */
    var mist = ctx.createLinearGradient(0, 0, 0, size);
    mist.addColorStop(0, 'rgba(250,246,236,0.16)');
    mist.addColorStop(0.5, 'rgba(252,249,240,0.26)');
    mist.addColorStop(1, 'rgba(250,246,236,0.16)');
    ctx.fillStyle = mist;
    ctx.fillRect(0, 0, size, size);

    var tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  /* ---------- 土星光环贴图（1D 同心细带） ---------- */

  /* 光环并非实心圆盘，而是无数条平行同心细带：
     颜色亮白 → 浅灰褐，中间夹较暗缝隙（卡西尼缝等），如巨大黑胶唱片/层层细纱。
     u 轴 = 径向（内缘 0 → 外缘 1），返回 512×1 的 THREE.CanvasTexture */
  function makeSaturnRingTexture(width) {
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = 1;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(width, 1);
    var i, f, a, band, band2, w, cf, cf2;
    for (i = 0; i < width; i++) {
      f = i / (width - 1);
      /* 同心细带：高频细纹 × 中频带组（黑胶唱片/细纱感） */
      band = Math.sin(f * 190) * 0.5 + 0.5;
      band2 = Math.sin(f * 47 + 1.3) * 0.5 + 0.5;
      a = 0.35 + 0.55 * band * (0.5 + 0.5 * band2);
      /* 颜色：亮白 ↔ 浅灰褐 */
      w = 0.5 + 0.5 * Math.sin(f * 71 + 2.1);
      /* 内缘渐入 */
      if (f < 0.08) a *= f / 0.08;
      /* 卡西尼缝（主缝隙：明显变暗变透） */
      cf = (f - 0.62) / 0.08;
      if (cf > 0 && cf < 1) a *= 0.08 + 0.92 * Math.pow(Math.abs(cf - 0.5) * 2, 1.5);
      /* 次级暗缝 */
      cf2 = (f - 0.34) / 0.05;
      if (cf2 > 0 && cf2 < 1) a *= 0.25 + 0.75 * Math.pow(Math.abs(cf2 - 0.5) * 2, 2);
      /* 外缘渐隐 */
      if (f > 0.9) a *= (1 - f) / 0.1;
      a = Math.max(0, Math.min(1, a));
      img.data[i * 4] = 190 + 50 * w;
      img.data[i * 4 + 1] = 182 + 54 * w;
      img.data[i * 4 + 2] = 168 + 60 * w;
      img.data[i * 4 + 3] = a * 255;
    }
    ctx.putImageData(img, 0, 0);
    var tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  /* ---------- 天王星表面纹理（程序化 Canvas 贴图） ---------- */

  /* 天王星：均匀、通透的冰蓝色（青绿色/蓝绿色），色调极致纯净，
     宛如无瑕的淡青色玉石 / 冰封的深海；
     质感极其光滑"丝滑"（平静水面/被挤压的甲烷气体），无岩石起伏、无剧烈风暴或明显条纹带；
     核心特征——极简"无特征"：至多隐约可见极其微弱的横向淡色云带，
     被朦胧光线吞没、若有若无；散发冰冷、寂静、高冷、遗世独立的气质。
     水平方向整数波数保证左右无缝，球形轮廓保持不变（仅表面着色）。
     返回 THREE.CanvasTexture */
  function makeUranusTexture(size) {
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');

    /* 冰蓝色板（青绿/蓝绿，极致纯净） */
    var UPAL = [
      '159,217,222', '176,222,224', '143,201,212',
      '181,226,228', '151,208,196'
    ];
    function rgba(c, a) { return 'rgba(' + c + ',' + a + ')'; }

    var i, b, x, y;

    /* 底色：极浅纵向渐变（两极稍深、赤道稍亮 → 微妙的体积感） */
    var base = ctx.createLinearGradient(0, 0, 0, size);
    base.addColorStop(0, '#7cc0d0');
    base.addColorStop(0.35, '#a3dfe3');
    base.addColorStop(0.5, '#b2e6e9');
    base.addColorStop(0.65, '#a3dfe3');
    base.addColorStop(1, '#7cc0d0');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);

    /* 微弱横向淡色云带：极低的可见度（若有若无，被朦胧吞没） */
    function wavyBand(yc, ht, amp, k, p1, p2, fill) {
      var step = size / 256, x2, y2, first = true;
      ctx.beginPath();
      for (x2 = 0; x2 <= size + step / 2; x2 += step) {
        y2 = yc - ht + amp * Math.sin((x2 / size) * TWO_PI * k + p1);
        if (first) { ctx.moveTo(x2, y2); first = false; }
        else ctx.lineTo(x2, y2);
      }
      first = true;
      for (x2 = size; x2 >= -step / 2; x2 -= step) {
        y2 = yc + ht + amp * Math.sin((x2 / size) * TWO_PI * k + p2);
        if (first) { ctx.lineTo(x2, y2); first = false; }
        else ctx.lineTo(x2, y2);
      }
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }

    var NB = 10;
    for (b = 0; b < NB; b++) {
      var yc = (b + 0.5) * (size / NB) + (Math.random() - 0.5) * (size / NB) * 0.5;
      var ht = (size / NB) * (0.3 + Math.random() * 0.3);
      var amp = size * (0.002 + Math.random() * 0.005);
      var k = 1 + Math.floor(Math.random() * 2);
      var p1 = Math.random() * TWO_PI;
      var p2 = p1 + Math.random() * 1.0;
      wavyBand(yc, ht, amp, k, p1, p2, rgba(UPAL[b % UPAL.length], 0.025 + Math.random() * 0.045));
    }

    /* 极细拉丝：几乎不可辨（丝滑平静的水面感） */
    for (i = 0; i < 24; i++) {
      var sy = Math.random() * size;
      var amp2 = size * (0.0015 + Math.random() * 0.004);
      var k2 = 1 + Math.floor(Math.random() * 3);
      var ph2 = Math.random() * TWO_PI;
      ctx.strokeStyle = rgba(UPAL[Math.floor(Math.random() * UPAL.length)], 0.02 + Math.random() * 0.03);
      ctx.lineWidth = size * (0.0015 + Math.random() * 0.005);
      ctx.lineCap = 'round';
      ctx.beginPath();
      var step2 = size / 256, first2 = true;
      for (x = 0; x <= size + step2 / 2; x += step2) {
        y = sy + amp2 * Math.sin((x / size) * TWO_PI * k2 + ph2);
        if (first2) { ctx.moveTo(x, y); first2 = false; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    /* 整体朦胧光罩：柔光罩效果（明暗过渡均匀平滑、丝滑） */
    var mist = ctx.createLinearGradient(0, 0, 0, size);
    mist.addColorStop(0, 'rgba(220,244,246,0.16)');
    mist.addColorStop(0.5, 'rgba(235,250,251,0.24)');
    mist.addColorStop(1, 'rgba(220,244,246,0.16)');
    ctx.fillStyle = mist;
    ctx.fillRect(0, 0, size, size);

    var tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  /* ---------- 海王星表面纹理（程序化 Canvas 贴图） ---------- */

  /* 海王星：主色深邃蔚蓝、深钴蓝、宝石蓝（比天王星深得多、饱和得多），
     如深不可测的蓝宝石 / 极度寒冷深邃的海洋；
     表面光滑气态但流动翻腾（如一团被搅动的浓稠蓝墨水）；
     核心特征（动态云层）：
     明亮丝带——深蓝色底上醒目的亮白/浅蓝云带，双正弦叠加呈扭曲波浪状（狂风卷起的雪花），
     中上部一条如丝带飘舞的亮带；
     暗色条纹——比背景更深的暗蓝色带与斑块，大暗斑（+明亮伴云）与明暗相间气旋，
     大气活动极度狂暴；与天王星的"无特征"相比明暗对比强烈、层次丰富。
     水平方向整数波数保证左右无缝，球形轮廓保持完美正圆。返回 THREE.CanvasTexture */
  function makeNeptuneTexture(size) {
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');

    /* 深蓝板：深钴蓝 / 宝石蓝（深）/ 深邃蔚蓝 / 亮蔚蓝 / 浅蓝（丝带） */
    var NPAL = ['22,48,124', '16,32,78', '34,72,180', '42,92,216', '201,228,255'];
    function rgba(c, a) { return 'rgba(' + c + ',' + a + ')'; }

    var i, b, x, y;

    /* 底色：深而饱和（深不见底的蓝宝石/深海），两极稍深、赤道稍亮（幽深感） */
    var base = ctx.createLinearGradient(0, 0, 0, size);
    base.addColorStop(0, '#142c74');
    base.addColorStop(0.35, '#1c3f9e');
    base.addColorStop(0.5, '#2552c4');
    base.addColorStop(0.65, '#1c3f9e');
    base.addColorStop(1, '#142c74');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);

    /* 波浪带（上下缘正弦 → 翻滚感），整数波数 → 左右无缝 */
    function wavyBand(yc, ht, amp, k, p1, p2, fill) {
      var step = size / 256, x2, y2, first = true;
      ctx.beginPath();
      for (x2 = 0; x2 <= size + step / 2; x2 += step) {
        y2 = yc - ht + amp * Math.sin((x2 / size) * TWO_PI * k + p1);
        if (first) { ctx.moveTo(x2, y2); first = false; }
        else ctx.lineTo(x2, y2);
      }
      first = true;
      for (x2 = size; x2 >= -step / 2; x2 -= step) {
        y2 = yc + ht + amp * Math.sin((x2 / size) * TWO_PI * k + p2);
        if (first) { ctx.lineTo(x2, y2); first = false; }
        else ctx.lineTo(x2, y2);
      }
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }

    /* 暗色条纹：比背景更深的暗蓝色带与斑块（狂暴大气） */
    var NB = 12;
    for (b = 0; b < NB; b++) {
      var yc = (b + 0.5) * (size / NB) + (Math.random() - 0.5) * (size / NB) * 0.5;
      var ht = (size / NB) * (0.3 + Math.random() * 0.35);
      var amp = size * (0.008 + Math.random() * 0.02);
      var k = 1 + Math.floor(Math.random() * 3);
      var p1 = Math.random() * TWO_PI;
      var p2 = p1 + Math.random() * 1.8;
      var dark = Math.random() < 0.65; // 暗蓝带为主，间有亮蔚蓝带
      wavyBand(yc, ht, amp, k, p1, p2,
        dark ? rgba(NPAL[b % 2 === 0 ? 0 : 1], 0.22 + Math.random() * 0.3)
             : rgba(NPAL[2 + (b % 2)], 0.14 + Math.random() * 0.16));
    }

    /* 明亮丝带：双正弦叠加（低频大波 × 高频细波 → 扭曲波浪状、飘舞感） */
    function ribbon(yc, ht, a1, k1, p1, a2, k2, p2, fill) {
      var step = size / 256, x2, y2, first = true;
      function e(yb, ph1, ph2) {
        return yb
          + a1 * Math.sin((x2 / size) * TWO_PI * k1 + ph1)
          + a2 * Math.sin((x2 / size) * TWO_PI * k2 + ph2);
      }
      ctx.beginPath();
      for (x2 = 0; x2 <= size + step / 2; x2 += step) {
        y2 = e(yc - ht, p1, p2);
        if (first) { ctx.moveTo(x2, y2); first = false; }
        else ctx.lineTo(x2, y2);
      }
      first = true;
      for (x2 = size; x2 >= -step / 2; x2 -= step) {
        y2 = e(yc + ht, p1 + 0.9, p2 + 1.6);
        if (first) { ctx.lineTo(x2, y2); first = false; }
        else ctx.lineTo(x2, y2);
      }
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }

    /* 主亮带（中上部，如丝带飘舞的亮白/浅蓝带） */
    var r1p = Math.random() * TWO_PI;
    ribbon(size * 0.32, size * 0.016, size * 0.013, 2, r1p, size * 0.006, 6, r1p + 2, rgba('238,246,255', 0.5));
    ribbon(size * 0.37, size * 0.010, size * 0.010, 2, r1p + 1, size * 0.005, 7, r1p + 4, rgba('180,212,255', 0.34));
    ribbon(size * 0.60, size * 0.012, size * 0.011, 1, r1p + 2.4, size * 0.005, 5, r1p + 5, rgba('226,240,255', 0.3));
    /* 其余若有若无的亮带 */
    for (i = 0; i < 4; i++) {
      var ry = Math.random() * size;
      var rp = Math.random() * TWO_PI;
      ribbon(ry, size * (0.006 + Math.random() * 0.01), size * (0.006 + Math.random() * 0.012),
        1 + Math.floor(Math.random() * 2), rp, size * 0.004, 4 + Math.floor(Math.random() * 3), rp + 1,
        rgba(NPAL[4], 0.1 + Math.random() * 0.12));
    }

    /* 搅动感：浓稠蓝墨水般的翻腾笔画（明暗交织） */
    for (i = 0; i < 40; i++) {
      var sy = Math.random() * size;
      var amp1 = size * (0.004 + Math.random() * 0.012);
      var k1 = 1 + Math.floor(Math.random() * 3);
      var p1 = Math.random() * TWO_PI;
      ctx.strokeStyle = Math.random() < 0.4
        ? rgba('180,208,250', 0.06 + Math.random() * 0.1)
        : rgba('12,24,64', 0.08 + Math.random() * 0.12);
      ctx.lineWidth = size * (0.004 + Math.random() * 0.014);
      ctx.lineCap = 'round';
      ctx.beginPath();
      var step2 = size / 256, first2 = true;
      for (x = 0; x <= size + step2 / 2; x += step2) {
        y = sy + amp1 * Math.sin((x / size) * TWO_PI * k1 + p1)
          + amp1 * 0.5 * Math.sin((x / size) * TWO_PI * (k1 * 3 + 1) + p1 * 2);
        if (first2) { ctx.moveTo(x, y); first2 = false; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    /* 大暗斑：巨大深色椭圆风暴 + 明亮边缘 + 伴云 */
    var gsx = size * 0.38, gsy = size * 0.42;
    var gsrx = size * 0.1, gsry = size * 0.06;
    ctx.save();
    ctx.translate(gsx, gsy);
    ctx.scale(1, gsry / gsrx);
    var gspot = ctx.createRadialGradient(0, 0, gsrx * 0.1, 0, 0, gsrx);
    gspot.addColorStop(0, 'rgba(8,16,48,0.92)');
    gspot.addColorStop(0.7, 'rgba(12,24,66,0.85)');
    gspot.addColorStop(1, 'rgba(20,40,104,0.25)');
    ctx.fillStyle = gspot;
    ctx.beginPath();
    ctx.arc(0, 0, gsrx, 0, TWO_PI);
    ctx.fill();
    /* 明亮边缘（大暗斑的亮缘） */
    ctx.strokeStyle = 'rgba(190,216,255,0.3)';
    ctx.lineWidth = Math.max(1.5, size * 0.003);
    ctx.stroke();
    ctx.restore();

    /* 伴云：大暗斑上缘的明亮白云 */
    ctx.save();
    ctx.translate(gsx + gsrx * 0.55, gsy - gsry * 0.8);
    ctx.scale(1, 0.55);
    var comp = ctx.createRadialGradient(0, 0, 0, 0, 0, gsrx * 0.3);
    comp.addColorStop(0, 'rgba(235,244,255,0.85)');
    comp.addColorStop(1, 'rgba(235,244,255,0)');
    ctx.fillStyle = comp;
    ctx.beginPath();
    ctx.arc(0, 0, gsrx * 0.3, 0, TWO_PI);
    ctx.fill();
    ctx.restore();

    /* 明暗相间气旋：数个小圆形涡旋（暗心 + 亮缘） */
    for (i = 0; i < 4; i++) {
      var wx = size * (0.12 + Math.random() * 0.76);
      var wy = size * (0.15 + Math.random() * 0.7);
      var wrx = size * (0.03 + Math.random() * 0.04);
      var wry = wrx * (0.5 + Math.random() * 0.3);
      ctx.save();
      ctx.translate(wx, wy);
      ctx.scale(1, wry / wrx);
      var vort = ctx.createRadialGradient(0, 0, 0, 0, 0, wrx);
      vort.addColorStop(0, 'rgba(10,20,56,0.7)');
      vort.addColorStop(0.65, 'rgba(16,32,84,0.4)');
      vort.addColorStop(0.85, 'rgba(160,196,250,0.35)');
      vort.addColorStop(1, 'rgba(160,196,250,0)');
      ctx.fillStyle = vort;
      ctx.beginPath();
      ctx.arc(0, 0, wrx, 0, TWO_PI);
      ctx.fill();
      ctx.restore();
    }

    /* 幽深感薄纱：上下缘淡深蓝晕（深不见底） */
    var mist = ctx.createLinearGradient(0, 0, 0, size);
    mist.addColorStop(0, 'rgba(8,16,50,0.18)');
    mist.addColorStop(0.5, 'rgba(20,40,110,0.05)');
    mist.addColorStop(1, 'rgba(8,16,50,0.18)');
    ctx.fillStyle = mist;
    ctx.fillRect(0, 0, size, size);

    var tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  /* ---------- 地球表面纹理（程序化 Canvas 贴图） ---------- */

  /* 地球：主色深邃蔚蓝/碧蓝（浩瀚海洋，巨大蓝宝石）；
     点缀翠绿植被、土黄/棕色大陆（沙漠与山脉起伏）、两极纯白冰盖；
     固体表面被厚云层覆盖——白色云系（大小不一的漩涡与条带，如洁白棉花/拉丝糖霜，
     顺大气环流扭动）+ 带巨大漩涡的台风；
     整体流动、半透明、柔软的质感。
     水平方向整数波数/环绕复制保证左右无缝，球形轮廓保持（仅表面着色）。
     返回 THREE.CanvasTexture */
  function makeEarthTexture(size) {
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');

    var i, x, y, r;

    /* 海洋基底：深邃蔚蓝/碧蓝（两极稍深、赤道稍亮） */
    var base = ctx.createLinearGradient(0, 0, 0, size);
    base.addColorStop(0, '#173f8f');
    base.addColorStop(0.35, '#1e56b4');
    base.addColorStop(0.5, '#2a72d8');
    base.addColorStop(0.65, '#1e56b4');
    base.addColorStop(1, '#173f8f');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);

    /* 海洋细微色变 */
    for (i = 0; i < 80; i++) {
      x = Math.random() * size;
      y = Math.random() * size;
      r = size * (0.01 + Math.random() * 0.05);
      ctx.fillStyle = Math.random() < 0.5 ? 'rgba(40,110,210,0.12)' : 'rgba(20,60,140,0.12)';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TWO_PI);
      ctx.fill();
    }

    /* 大陆板块：巨大不规则陆地（软边缘圆簇拼合）
       基底翠绿植被 + 土黄/棕色沙漠斑块 + 山脉起伏暗纹 */
    function continent(cx, cy, spread, blobs) {
      var bi;
      for (bi = 0; bi < blobs; bi++) {
        var bx = cx + (Math.random() - 0.5) * spread;
        var by = cy + (Math.random() - 0.5) * spread * 0.7;
        var br = size * (0.02 + Math.random() * 0.05);
        var gg = Math.random() < 0.5 ? '74,138,58' : '122,168,70'; // 翠绿 ↔ 浅绿
        var g = ctx.createRadialGradient(bx, by, br * 0.3, bx, by, br);
        g.addColorStop(0, 'rgba(' + gg + ',0.95)');
        g.addColorStop(0.7, 'rgba(' + gg + ',0.7)');
        g.addColorStop(1, 'rgba(' + gg + ',0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(bx, by, br, 0, TWO_PI);
        ctx.fill();
      }
      /* 沙漠/干旱区：土黄/棕色斑块 */
      for (bi = 0; bi < Math.ceil(blobs / 2); bi++) {
        var dx = cx + (Math.random() - 0.5) * spread * 0.8;
        var dy = cy + (Math.random() - 0.5) * spread * 0.55;
        var dr = size * (0.012 + Math.random() * 0.035);
        var gd = ctx.createRadialGradient(dx, dy, 0, dx, dy, dr);
        gd.addColorStop(0, 'rgba(176,138,74,0.7)');
        gd.addColorStop(1, 'rgba(176,138,74,0)');
        ctx.fillStyle = gd;
        ctx.beginPath();
        ctx.arc(dx, dy, dr, 0, TWO_PI);
        ctx.fill();
      }
      /* 山脉起伏：暗绿褐短弧 */
      for (bi = 0; bi < 5; bi++) {
        var mx = cx + (Math.random() - 0.5) * spread * 0.7;
        var my = cy + (Math.random() - 0.5) * spread * 0.5;
        ctx.strokeStyle = 'rgba(84,70,40,0.25)';
        ctx.lineWidth = 1 + Math.random() * 2;
        ctx.beginPath();
        var m0 = Math.random() * TWO_PI;
        ctx.arc(mx, my, size * (0.008 + Math.random() * 0.02), m0, m0 + Math.PI);
        ctx.stroke();
      }
    }

    /* 五大板块（美洲/非洲/亚欧/澳洲等大体轮廓，避开左右接缝） */
    var CONTS = [
      [0.20, 0.36, 0.20, 16],
      [0.27, 0.66, 0.15, 12],
      [0.55, 0.40, 0.15, 12],
      [0.57, 0.60, 0.12, 10],
      [0.78, 0.38, 0.18, 14],
      [0.82, 0.66, 0.10, 8]
    ];
    for (i = 0; i < CONTS.length; i++) {
      continent(size * CONTS[i][0], size * CONTS[i][1], size * CONTS[i][2], CONTS[i][3]);
    }

    /* 极地冰盖：纯白（与蔚蓝海洋强冷暖对比），边缘参差 */
    var capH = size * 0.10;
    var capTop = ctx.createLinearGradient(0, 0, 0, capH);
    capTop.addColorStop(0, 'rgba(250,252,255,0.98)');
    capTop.addColorStop(0.6, 'rgba(246,250,254,0.7)');
    capTop.addColorStop(1, 'rgba(246,250,254,0)');
    ctx.fillStyle = capTop;
    ctx.fillRect(0, 0, size, capH);

    var capBot = ctx.createLinearGradient(0, size, 0, size - capH);
    capBot.addColorStop(0, 'rgba(250,252,255,0.98)');
    capBot.addColorStop(0.6, 'rgba(246,250,254,0.7)');
    capBot.addColorStop(1, 'rgba(246,250,254,0)');
    ctx.fillStyle = capBot;
    ctx.fillRect(0, size - capH, size, capH);

    /* 冰盖边缘斑驳（左右环绕复制） */
    for (i = 0; i < 12; i++) {
      var ix = Math.random() * size;
      var iy = Math.random() < 0.5
        ? Math.random() * capH * 0.8
        : size - Math.random() * capH * 0.8;
      var ir = size * (0.02 + Math.random() * 0.04);
      var ia = 0.2 + Math.random() * 0.2;
      var off;
      for (off = -1; off <= 1; off++) {
        var gcap = ctx.createRadialGradient(ix + off * size, iy, 0, ix + off * size, iy, ir);
        gcap.addColorStop(0, 'rgba(252,254,255,' + ia + ')');
        gcap.addColorStop(1, 'rgba(252,254,255,0)');
        ctx.fillStyle = gcap;
        ctx.fillRect(ix + off * size - ir, iy - ir, ir * 2, ir * 2);
      }
    }

    /* 云系条带：白色柔软波段（顺大气环流方向扭动），整数波数 → 左右无缝 */
    function wavyBand(yc, ht, amp, k, p1, p2, fill) {
      var step = size / 256, x2, y2, first = true;
      ctx.beginPath();
      for (x2 = 0; x2 <= size + step / 2; x2 += step) {
        y2 = yc - ht + amp * Math.sin((x2 / size) * TWO_PI * k + p1);
        if (first) { ctx.moveTo(x2, y2); first = false; }
        else ctx.lineTo(x2, y2);
      }
      first = true;
      for (x2 = size; x2 >= -step / 2; x2 -= step) {
        y2 = yc + ht + amp * Math.sin((x2 / size) * TWO_PI * k + p2);
        if (first) { ctx.lineTo(x2, y2); first = false; }
        else ctx.lineTo(x2, y2);
      }
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }

    for (i = 0; i < 10; i++) {
      var cby = (i + 0.5) * (size / 10) + (Math.random() - 0.5) * (size / 10) * 0.6;
      var cbh = (size / 10) * (0.18 + Math.random() * 0.22);
      wavyBand(cby, cbh, size * (0.004 + Math.random() * 0.012),
        1 + Math.floor(Math.random() * 3),
        Math.random() * TWO_PI, Math.random() * TWO_PI,
        'rgba(255,255,255,' + (0.10 + Math.random() * 0.18) + ')');
    }

    /* 白色漩涡云团：大小不一（洁白棉花/拉丝糖霜） */
    for (i = 0; i < 26; i++) {
      var wx = Math.random() * size;
      var wy = size * (0.12 + Math.random() * 0.76);
      var wrx = size * (0.012 + Math.random() * 0.035);
      var wry = wrx * (0.4 + Math.random() * 0.4);
      ctx.save();
      ctx.translate(wx, wy);
      ctx.scale(1, wry / wrx);
      var ws = ctx.createRadialGradient(0, 0, 0, 0, 0, wrx);
      ws.addColorStop(0, 'rgba(255,255,255,' + (0.3 + Math.random() * 0.3) + ')');
      ws.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = ws;
      ctx.beginPath();
      ctx.arc(0, 0, wrx, 0, TWO_PI);
      ctx.fill();
      /* 漩涡感：两道弧 */
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.2 + Math.random() * 0.2) + ')';
      ctx.lineWidth = Math.max(1, wrx * 0.12);
      var a0 = Math.random() * TWO_PI;
      ctx.beginPath();
      ctx.arc(0, 0, wrx * 0.55, a0, a0 + Math.PI * 1.2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, wrx * 0.85, a0 + 0.6, a0 + Math.PI * 1.6);
      ctx.stroke();
      ctx.restore();
    }

    /* 台风：带巨大漩涡的白色风暴（螺旋 + 台风眼） */
    function typhoon(cx, cy, R) {
      /* 云体 */
      var td = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      td.addColorStop(0, 'rgba(255,255,255,0.5)');
      td.addColorStop(0.7, 'rgba(255,255,255,0.32)');
      td.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = td;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TWO_PI);
      ctx.fill();
      /* 螺旋臂 */
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = R * 0.14;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (var t = 0; t <= 48; t++) {
        var a4 = (t / 48) * TWO_PI * 2.1;
        var r4 = R * (0.12 + 0.88 * (t / 48));
        var px = cx + Math.cos(a4) * r4;
        var py = cy + Math.sin(a4) * r4 * 0.82;
        if (t === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      /* 台风眼 */
      ctx.fillStyle = 'rgba(70,95,130,0.45)';
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.1, 0, TWO_PI);
      ctx.fill();
    }

    typhoon(size * 0.3, size * 0.34, size * 0.045);
    typhoon(size * 0.62, size * 0.62, size * 0.05);
    typhoon(size * 0.82, size * 0.3, size * 0.035);

    /* 整体云幕：厚云层的半透明柔化（流动、柔软） */
    var haze = ctx.createLinearGradient(0, 0, 0, size);
    haze.addColorStop(0, 'rgba(255,255,255,0.05)');
    haze.addColorStop(0.5, 'rgba(255,255,255,0.10)');
    haze.addColorStop(1, 'rgba(255,255,255,0.05)');
    ctx.fillStyle = haze;
    ctx.fillRect(0, 0, size, size);

    var tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  /* 行星：行星组（orbitGroup，旋转实现公转）> axisGroup（自转轴倾角）> mesh（自转）
     水星使用程序化表面纹理（makeMercuryTexture：环形山/斑驳/冷灰岩石质感）；
     金星使用程序化云层纹理（makeVenusTexture：带状云雾/拉花流纹/朦胧斑块）；
     火星使用程序化表面纹理（makeMarsTexture：铁锈红/斑驳/冰盖/峡谷/火山）；
     木星使用程序化表面纹理（makeJupiterTexture：平行条纹/大红斑/白色风暴/油画拉丝）；
     土星使用柔和表面纹理 + 同心细带光环（makeSaturnRingTexture），自转极快呈扁球体，
     球体与光环 castShadow/receiveShadow 互相遮挡、互相投影；
     天王星使用极淡冰蓝纹理（makeUranusTexture），极轻微扁圆 + 背面加色光晕（半透明发光玻璃珠边缘）；
     海王星使用深蓝动态云层纹理（makeNeptuneTexture：亮白带/暗条纹/大暗斑/气旋），
     完美正圆 + 浓郁透光环边缘（比天王星更深的加色光晕）；
     地球使用程序化纹理（makeEarthTexture：蔚蓝海洋/大陆板块/冰盖/云系台风），
     稍扁椭球 + 极薄明亮淡蓝大气光晕（玻璃光泽边缘）+ 晨昏霞光暖色晕；
     地球生成月球（buildMoon）。
     记录 userData（名称、周期、简介、类型标识）。
     返回 { data, orbitGroup, axisGroup, mesh, ring, moon, orbitLine } */
  function buildPlanet(data, planetsGroup) {
    var orbitGroup = new THREE.Group();
    orbitGroup.name = 'orbitGroup:' + data.key;

    var axisGroup = new THREE.Group();
    axisGroup.name = 'axisGroup:' + data.key;
    axisGroup.position.x = data.orbitRadius;
    axisGroup.rotation.z = (data.axialTilt || 0) * Math.PI / 180; // 自转轴倾角
    orbitGroup.add(axisGroup);

    /* 水星：程序化表面纹理（冷峻灰白岩石 + 碗状环形山），冰冷坚硬的金属/岩石质感；
       金星：程序化云层纹理（带状云雾/拉花流纹/朦胧斑块），柔软雾蒙蒙的气体质感；
       火星：程序化表面纹理（铁锈红/斑驳明暗/两极冰盖/峡谷/火山），干涸粗糙的荒漠岩石质感；
       木星：程序化表面纹理（平行条纹/大红斑/白色风暴/油画拉丝），光滑粘稠的流体质感。
       四者颜色均由贴图承载；其余行星使用纯色 */
    var isMercury = data.key === 'mercury';
    var isVenus = data.key === 'venus';
    var isMars = data.key === 'mars';
    var isJupiter = data.key === 'jupiter';
    var isSaturn = data.key === 'saturn';
    var isUranus = data.key === 'uranus';
    var isNeptune = data.key === 'neptune';
    var isEarth = data.key === 'earth';
    var meshMat = new THREE.MeshStandardMaterial(
      isMercury
        ? { color: 0xffffff, map: makeMercuryTexture(1024), roughness: 0.92, metalness: 0.22 }
        : isVenus
          ? { color: 0xffffff, map: makeVenusTexture(1024), roughness: 0.95, metalness: 0.0 }
          : isMars
            ? { color: 0xffffff, map: makeMarsTexture(1024), roughness: 0.95, metalness: 0.05 }
            : isJupiter
              ? { color: 0xffffff, map: makeJupiterTexture(1024), roughness: 0.6, metalness: 0.0 }
              : isSaturn
                ? { color: 0xffffff, map: makeSaturnTexture(1024), roughness: 0.7, metalness: 0.0 }
                : isUranus
                  ? { color: 0xffffff, map: makeUranusTexture(1024), roughness: 0.35, metalness: 0.0 }
                  : isNeptune
                    ? { color: 0xffffff, map: makeNeptuneTexture(1024), roughness: 0.42, metalness: 0.0 }
                    : isEarth
                      ? { color: 0xffffff, map: makeEarthTexture(1024), roughness: 0.5, metalness: 0.08 }
                      : { color: new THREE.Color(data.color), roughness: 0.85, metalness: 0.08 }
    );
    var mesh = new THREE.Mesh(
      new THREE.SphereGeometry(data.radius, 40, 40),
      meshMat
    );
    /* 土星：自转极快 → 略被压扁的扁球体（极半径 ≈ 赤道半径 90%）；
       球体与光环互相遮挡、互相投影（阴影由太阳点光源投影实现） */
    if (isSaturn) {
      mesh.scale.set(1, 0.9, 1);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    /* 天王星：自转较快但扁圆极轻微（肉眼几乎不可察觉）；
       柔和发光边缘：稍大的背面加色球 → 半透明发光玻璃珠的淡淡晕影 */
    if (isUranus) {
      mesh.scale.set(1, 0.98, 1);
      var halo = new THREE.Mesh(
        new THREE.SphereGeometry(data.radius * 1.07, 40, 40),
        new THREE.MeshBasicMaterial({
          color: 0x9fd9de, transparent: true, opacity: 0.09,
          side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false
        })
      );
      halo.scale.set(1, 0.98, 1);
      halo.name = 'halo:' + data.key;
      axisGroup.add(halo);
    }
    /* 海王星：完美正圆（不扁）；柔和晕影比天王星更"浓郁"、边缘微微透光 */
    if (isNeptune) {
      var halo = new THREE.Mesh(
        new THREE.SphereGeometry(data.radius * 1.07, 40, 40),
        new THREE.MeshBasicMaterial({
          color: 0x2a5ad0, transparent: true, opacity: 0.12,
          side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false
        })
      );
      halo.name = 'halo:' + data.key;
      axisGroup.add(halo);
    }
    /* 地球：稍扁椭球（肉眼几乎不可察）+ 大气层——
       极薄、极明亮柔和的淡蓝色光晕（玻璃光泽边缘）+ 晨昏线暖色霞光（微弱橙红晕） */
    if (isEarth) {
      mesh.scale.set(1, 0.995, 1);
      var atmoA = new THREE.Mesh(
        new THREE.SphereGeometry(data.radius * 1.045, 40, 40),
        new THREE.MeshBasicMaterial({
          color: 0x9fc8ff, transparent: true, opacity: 0.18,
          side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false
        })
      );
      atmoA.scale.set(1, 0.995, 1);
      atmoA.name = 'atmoA';
      var atmoB = new THREE.Mesh(
        new THREE.SphereGeometry(data.radius * 1.08, 40, 40),
        new THREE.MeshBasicMaterial({
          color: 0xb8dcff, transparent: true, opacity: 0.07,
          side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false
        })
      );
      atmoB.scale.set(1, 0.995, 1);
      atmoB.name = 'atmoB';
      var atmoWarm = new THREE.Mesh(
        new THREE.SphereGeometry(data.radius * 1.06, 40, 40),
        new THREE.MeshBasicMaterial({
          color: 0xffb27a, transparent: true, opacity: 0.05,
          side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false
        })
      );
      atmoWarm.scale.set(1, 0.995, 1);
      atmoWarm.name = 'atmoWarm';
      axisGroup.add(atmoA);
      axisGroup.add(atmoB);
      axisGroup.add(atmoWarm);
    }
    mesh.name = data.key;
    mesh.userData = {
      isSun: false, isMoon: false,
      key: data.key, name: data.name, type: data.type,
      period: data.period, orbitRadius: data.orbitRadius,
      axialTilt: data.axialTilt, info: data.info
    };
    axisGroup.add(mesh);

    /* 土星光环：同心细带贴图（亮白→浅灰褐、卡西尼缝），如巨大黑胶唱片/层层细纱；
       RingGeometry UV 重映射为径向（u = 半径比例）以适配 1D 带状贴图；
       随自转轴倾斜，castShadow/receiveShadow 与球体互相遮挡、互相投影 */
    var ring = null;
    if (data.ring) {
      var ringGeo = new THREE.RingGeometry(data.ring.inner, data.ring.outer, 128, 1);
      var ruv = ringGeo.attributes.uv;
      var rpos = ringGeo.attributes.position;
      var rspan = data.ring.outer - data.ring.inner;
      for (var ri = 0; ri < ruv.count; ri++) {
        var rr = Math.sqrt(rpos.getX(ri) * rpos.getX(ri) + rpos.getY(ri) * rpos.getY(ri));
        ruv.setXY(ri, (rr - data.ring.inner) / rspan, 0.5);
      }
      ring = new THREE.Mesh(
        ringGeo,
        new THREE.MeshStandardMaterial({
          map: makeSaturnRingTexture(512),
          color: 0xffffff,
          side: THREE.DoubleSide, transparent: true, depthWrite: false,
          roughness: 0.85, metalness: 0
        })
      );
      ring.name = 'ring:' + data.key;
      ring.rotation.x = -Math.PI / 2;
      ring.castShadow = true;    // 光环在球体暗面投下拱形黑影
      ring.receiveShadow = true; // 球体在背日侧光环上投下大片阴影
      axisGroup.add(ring);
    }

    /* 地球月球 */
    var moon = null;
    if (data.moon) {
      moon = buildMoon(data.moon, axisGroup);
    }

    /* 行星圆形轨道线（以太阳为中心，加入 planetsGroup） */
    var orbitLine = makeOrbitCircle(data.orbitRadius, 0x3a5a9a, 0.45);
    orbitLine.name = 'orbitLine:' + data.key;
    planetsGroup.add(orbitLine);

    planetsGroup.add(orbitGroup);

    return {
      data: data,
      orbitGroup: orbitGroup,
      axisGroup: axisGroup,
      mesh: mesh,
      ring: ring,
      moon: moon,
      orbitLine: orbitLine
    };
  }

  /* 依据 SOLAR_DATA.planets 生成八大行星。
     层级：scene > solarGroup > planetsGroup > axisGroup > mesh
     返回 { group, planets } */
  function buildPlanets(parent, list) {
    var planetsGroup = new THREE.Group();
    planetsGroup.name = 'planetsGroup';
    var planets = [];
    var i;
    for (i = 0; i < list.length; i++) {
      planets.push(buildPlanet(list[i], planetsGroup));
    }
    parent.add(planetsGroup);
    return { group: planetsGroup, planets: planets };
  }

  if (!window.SOLAR_DATA.planets || !window.SOLAR_DATA.planets.length) {
    showFatal('SOLAR_DATA.planets 未定义或为空');
    return;
  }

  var planetsBuild = buildPlanets(solarGroup, window.SOLAR_DATA.planets);
  var planetsGroup = planetsBuild.group;
  var planets = planetsBuild.planets;

  /* 天体注册表（拾取 / 聚焦 / 悬浮提示用） */

  var bodies = [
    {
      key: 'sun', name: '太阳', type: 'star',
      mesh: sun, radius: window.SOLAR_DATA.sun.radius, hex: window.SOLAR_DATA.sun.color,
      period: 0, info: window.SOLAR_DATA.sun.info, isSun: true, isMoon: false
    }
  ];
  var bi;
  for (bi = 0; bi < planets.length; bi++) {
    var pl = planets[bi];
    bodies.push({
      key: pl.data.key, name: pl.data.name, type: 'planet',
      mesh: pl.mesh, radius: pl.data.radius, hex: pl.data.color,
      period: pl.data.period, info: pl.data.info, isSun: false, isMoon: false
    });
    if (pl.moon) {
      bodies.push({
        key: pl.moon.data.key, name: pl.moon.data.name, type: 'satellite',
        mesh: pl.moon.mesh, radius: pl.moon.data.radius, hex: pl.moon.data.color,
        period: pl.moon.data.period, info: pl.moon.data.info, isSun: false, isMoon: true
      });
    }
  }

  /* ---------- 小行星带（模块 9：buildMeteors） ---------- */

  /* 火星与木星之间的 300 颗随机岩石：
     IcosahedronGeometry + MeshStandardMaterial(flatShading) 凹凸质感，
     随机大小 / 色调（HSL）/ 轨道倾角 / 公转与自转速度，动态绕太阳公转 + 自转。
     返回 { group, rocks, beltInner, beltOuter, update } */
  var METEOR_COUNT = 300;    // 岩石数量
  var METEOR_SPIN = 2.5e-5;  // 自转视觉系数（弧度/毫秒/天每秒）

  function buildMeteors(parent) {
    /* 带半径范围：取火星与木星轨道半径之间（数据驱动） */
    var list = window.SOLAR_DATA.planets;
    var earthR = null, marsR = null, jupR = null, li;
    for (li = 0; li < list.length; li++) {
      if (list[li].key === 'earth') earthR = list[li].orbitRadius;
      if (list[li].key === 'mars') marsR = list[li].orbitRadius;
      if (list[li].key === 'jupiter') jupR = list[li].orbitRadius;
    }
    if (!earthR || !marsR || !jupR) {
      throw new Error('buildMeteors: 缺少 earth/mars/jupiter 轨道半径数据');
    }
    var beltInner = marsR + (jupR - marsR) * 0.25;
    var beltOuter = marsR + (jupR - marsR) * 0.75;

    var group = new THREE.Group();
    group.name = 'asteroidBelt';

    var rocks = [];
    var i;
    for (i = 0; i < METEOR_COUNT; i++) {
      var radius = beltInner + Math.random() * (beltOuter - beltInner);
      var angle = Math.random() * Math.PI * 2;
      var size = 0.6 + Math.random() * 1.4;

      var mesh = new THREE.Mesh(
        new THREE.IcosahedronGeometry(size, 0),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color().setHSL(0.08, 0.15, 0.35 + Math.random() * 0.25),
          flatShading: true, roughness: 0.92, metalness: 0.08
        })
      );
      mesh.name = 'meteor:' + i;

      /* 开普勒第三定律：周期（地球年）= (r / r_earth)^1.5，内快外慢 */
      var period = Math.pow(radius / earthR, 1.5);

      rocks.push({
        mesh: mesh,
        radius: radius,
        period: period,
        incline: (Math.random() - 0.5) * 0.5,  // 随机轨道倾角（弧度，约 ±14°）
        angle: angle,                          // 当前公转角
        spinX: (Math.random() - 0.5) * 2,      // 自转角速度分量
        spinY: (Math.random() - 0.5) * 2,
        spinZ: (Math.random() - 0.5) * 2
      });

      group.add(mesh);
    }

    parent.add(group);

    /* 动态绕太阳公转 + 自转（受全局时间倍率 dps 驱动） */
    return {
      group: group,
      rocks: rocks,
      beltInner: beltInner,
      beltOuter: beltOuter,
      update: function (dt) {
        if (!dt) return;
        var orbitOmega = (TWO_PI * dps / DAYS_PER_YEAR) / 1000; // 弧度/毫秒
        var j, r, cosA, sinA, sinI, cosI;
        for (j = 0; j < rocks.length; j++) {
          r = rocks[j];
          r.angle += (orbitOmega / r.period) * dt;
          cosA = Math.cos(r.angle);
          sinA = Math.sin(r.angle);
          sinI = Math.sin(r.incline);
          cosI = Math.cos(r.incline);
          r.mesh.position.set(
            r.radius * cosA,
            -r.radius * sinA * sinI,
            r.radius * sinA * cosI
          );
          /* 自转（翻滚） */
          r.mesh.rotation.x += r.spinX * METEOR_SPIN * dps * dt;
          r.mesh.rotation.y += r.spinY * METEOR_SPIN * dps * dt;
          r.mesh.rotation.z += r.spinZ * METEOR_SPIN * dps * dt;
        }
      }
    };
  }

  var meteorBelt = buildMeteors(solarGroup);

  /* ---------- 柯伊伯带（模块 10：buildKuiperBelt） ---------- */

  /* 海王星轨道外侧的 400 颗小天体：
     IcosahedronGeometry + MeshStandardMaterial(flatShading) 凹凸质感，
     褐色岩石色调，较厚盘状分布（Y 向 ±3.5），缓慢公转 + 自转。
     返回 { group, ices, kInner, kOuter, update } */
  var KUIPER_COUNT = 400;    // 小天体数量
  var KUIPER_SPIN = 1.8e-5;  // 自转视觉系数（弧度/毫秒/天每秒）
  var KUIPER_THICK = 3.5;    // 盘状厚度（Y 向 ±3.5）

  function buildKuiperBelt(parent) {
    /* 带半径范围：海王星轨道外侧（数据驱动） */
    var list = window.SOLAR_DATA.planets;
    var earthR = null, nptR = null, li;
    for (li = 0; li < list.length; li++) {
      if (list[li].key === 'earth') earthR = list[li].orbitRadius;
      if (list[li].key === 'neptune') nptR = list[li].orbitRadius;
    }
    if (!earthR || !nptR) {
      throw new Error('buildKuiperBelt: 缺少 earth/neptune 轨道半径数据');
    }
    var kInner = nptR * 1.1;
    var kOuter = nptR * 1.5;

    var group = new THREE.Group();
    group.name = 'kuiperBelt';

    var ices = [];
    var i;
    for (i = 0; i < KUIPER_COUNT; i++) {
      var radius = kInner + Math.random() * (kOuter - kInner);
      var size = 0.6 + Math.random() * 1.4;
      var yOff = (Math.random() * 2 - 1) * KUIPER_THICK; // 较厚盘状：Y 向 ±3.5

      /* 随机 HSL 配色（褐色岩石色） */
      var color = new THREE.Color();
      color.setHSL(
        0.06 + Math.random() * 0.08,   // 色相：黄褐~褐
        0.05 + Math.random() * 0.15,   // 饱和度：低（灰调）
        0.25 + Math.random() * 0.20    // 明度：中低
      );

      var mesh = new THREE.Mesh(
        new THREE.IcosahedronGeometry(size, 1),
        new THREE.MeshStandardMaterial({
          color: color, flatShading: true, roughness: 0.7, metalness: 0.12
        })
      );
      mesh.name = 'kuiper:' + i;

      /* 开普勒第三定律：远距 → 长周期，缓慢公转 */
      var period = Math.pow(radius / earthR, 1.5);

      ices.push({
        mesh: mesh,
        radius: radius,
        period: period,
        yOff: yOff,
        angle: Math.random() * TWO_PI,
        spinX: (Math.random() - 0.5) * 2,
        spinY: (Math.random() - 0.5) * 2,
        spinZ: (Math.random() - 0.5) * 2
      });

      group.add(mesh);
    }

    parent.add(group);

    /* 缓慢公转 + 自转（受全局时间倍率 dps 驱动） */
    return {
      group: group,
      ices: ices,
      kInner: kInner,
      kOuter: kOuter,
      update: function (dt) {
        if (!dt) return;
        var orbitOmega = (TWO_PI * dps / DAYS_PER_YEAR) / 1000; // 弧度/毫秒
        var j, b, cosA, sinA;
        for (j = 0; j < ices.length; j++) {
          b = ices[j];
          b.angle += (orbitOmega / b.period) * dt;
          cosA = Math.cos(b.angle);
          sinA = Math.sin(b.angle);
          b.mesh.position.set(
            b.radius * cosA,
            b.yOff,
            b.radius * sinA
          );
          /* 自转（翻滚） */
          b.mesh.rotation.x += b.spinX * KUIPER_SPIN * dps * dt;
          b.mesh.rotation.y += b.spinY * KUIPER_SPIN * dps * dt;
          b.mesh.rotation.z += b.spinZ * KUIPER_SPIN * dps * dt;
        }
      }
    };
  }

  var kuiperBelt = buildKuiperBelt(solarGroup);

  /* ---------- 离散盘（模块 20：buildScatteredDisc） ---------- */

  /* 柯伊伯带外侧 200 颗离散冰质天体：
     离散盘成员轨道离心率高、倾角大，被海王星引力扰动"散射"至更远的空间；
     此处以更远的轨道范围（海王星轨道 1.4~2.6 倍）与更厚的盘状分布（Y 向 ±28）表现。
     冰蓝白色调（HSL 蓝青），IcosahedronGeometry + MeshStandardMaterial(flatShading)，
     缓慢公转 + 自转。
     返回 { group, ices, sInner, sOuter, update } */
  var SCATTERED_COUNT = 200;    // 小天体数量
  var SCATTERED_SPIN = 1.5e-5;  // 自转视觉系数（弧度/毫秒/天每秒）
  var SCATTERED_THICK = 28;     // 盘状厚度（Y 向 ±28，远厚于柯伊伯带，表现高倾角散射）

  function buildScatteredDisc(parent) {
    /* 盘半径范围：柯伊伯带外侧（数据驱动） */
    var list = window.SOLAR_DATA.planets;
    var earthR = null, nptR = null, li;
    for (li = 0; li < list.length; li++) {
      if (list[li].key === 'earth') earthR = list[li].orbitRadius;
      if (list[li].key === 'neptune') nptR = list[li].orbitRadius;
    }
    if (!earthR || !nptR) {
      throw new Error('buildScatteredDisc: 缺少 earth/neptune 轨道半径数据');
    }
    var sInner = nptR * 1.4;
    var sOuter = nptR * 2.6;

    var group = new THREE.Group();
    group.name = 'scatteredDisc';

    var ices = [];
    var i;
    for (i = 0; i < SCATTERED_COUNT; i++) {
      var radius = sInner + Math.random() * (sOuter - sInner);
      var size = 0.7 + Math.random() * 1.2;
      var yOff = (Math.random() * 2 - 1) * SCATTERED_THICK; // 高倾角散射：Y 向 ±28

      /* 随机 HSL 配色（冰蓝白色调） */
      var color = new THREE.Color();
      color.setHSL(
        0.55 + Math.random() * 0.10,   // 色相：蓝~青
        0.10 + Math.random() * 0.20,   // 饱和度：低（冰感）
        0.50 + Math.random() * 0.25    // 明度：偏亮
      );

      var mesh = new THREE.Mesh(
        new THREE.IcosahedronGeometry(size, 1),
        new THREE.MeshStandardMaterial({
          color: color, flatShading: true, roughness: 0.6, metalness: 0.08
        })
      );
      mesh.name = 'scattered:' + i;

      /* 开普勒第三定律：远距 → 长周期，缓慢公转 */
      var period = Math.pow(radius / earthR, 1.5);

      ices.push({
        mesh: mesh,
        radius: radius,
        period: period,
        yOff: yOff,
        angle: Math.random() * TWO_PI,
        spinX: (Math.random() - 0.5) * 2,
        spinY: (Math.random() - 0.5) * 2,
        spinZ: (Math.random() - 0.5) * 2
      });

      group.add(mesh);
    }

    parent.add(group);

    /* 缓慢公转 + 自转（受全局时间倍率 dps 驱动） */
    return {
      group: group,
      ices: ices,
      sInner: sInner,
      sOuter: sOuter,
      update: function (dt) {
        if (!dt) return;
        var orbitOmega = (TWO_PI * dps / DAYS_PER_YEAR) / 1000; // 弧度/毫秒
        var j, b, cosA, sinA;
        for (j = 0; j < ices.length; j++) {
          b = ices[j];
          b.angle += (orbitOmega / b.period) * dt;
          cosA = Math.cos(b.angle);
          sinA = Math.sin(b.angle);
          b.mesh.position.set(
            b.radius * cosA,
            b.yOff,
            b.radius * sinA
          );
          /* 自转（翻滚） */
          b.mesh.rotation.x += b.spinX * SCATTERED_SPIN * dps * dt;
          b.mesh.rotation.y += b.spinY * SCATTERED_SPIN * dps * dt;
          b.mesh.rotation.z += b.spinZ * SCATTERED_SPIN * dps * dt;
        }
      }
    };
  }

  var scatteredDisc = buildScatteredDisc(solarGroup);

  /* ---------- 哈雷彗星（模块 21：buildHalley） ---------- */

  /* 哈雷彗星：最著名的短周期彗星（周期约 75.3 年，逆行）。
     高离心率轨道（场景映射）：近日点 30（水金轨道之间，真实 0.59 天文单位），
     远日点 330（海王星之外，真实约 35 天文单位，柯伊伯带区域），轨道面相对黄道倾斜。
     位置由开普勒方程解出（牛顿迭代）：近日点快、远日点慢；
      平近点角随时间递减（逆行，与行星公转方向相反）。
      彗核（Icosahedron）+ 彗尾：位于彗核背向太阳一侧、长达 1–2 亿千米的尾巴，
      由彗核在太阳风作用下抛出的尘埃与气体组成——
      离子尾（气体，蓝色、较直较长）+ 尘埃尾（暖白、较宽较短、沿轨道略偏折）；
      长度与日距成反比（近日点最长、远日点最短）。
      返回 { orbitGroup, cometGroup, nucleus, ionTail, dustTail, update } */
  var HALLEY_A = 180;         // 半长轴（场景单位）
  var HALLEY_E = 5 / 6;       // 离心率（场景映射，真实 e ≈ 0.967）
  var HALLEY_PERIOD = 75.3;   // 公转周期（地球年，真实值）
  var HALLEY_TILT_X = 1.05;   // 轨道面绕 X 轴倾角（弧度，约 60°）
  var HALLEY_TILT_Z = -0.4;   // 轨道面绕 Z 轴偏转（弧度，主轴方位）
  var HALLEY_B = HALLEY_A * Math.sqrt(1 - HALLEY_E * HALLEY_E); // 半短轴 ≈ 99.5

  function buildHalley(parent) {
    /* 轨道面倾斜四元数：先绕 Z 轴再绕 X 轴（与 orbitGroup 朝向一致） */
    var tiltQ = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(1, 0, 0), HALLEY_TILT_X)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), HALLEY_TILT_Z));

    /* ---------- 轨道轨迹（局部 XZ 平面；太阳位于焦点；近日点在局部 +X 侧） ---------- */
    var orbitGroup = new THREE.Group();
    orbitGroup.name = 'halleyOrbit';
    orbitGroup.quaternion.copy(tiltQ);

    var pts = [];
    for (var s = 0; s <= 256; s++) {
      var ang = (s / 256) * TWO_PI;
      pts.push(new THREE.Vector3(
        HALLEY_A * Math.cos(ang) - HALLEY_A * HALLEY_E,
        0,
        HALLEY_B * Math.sin(ang)
      ));
    }
    var path = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x7fb8e8, transparent: true, opacity: 0.55 })
    );
    path.name = 'halleyPath';
    orbitGroup.add(path);
    parent.add(orbitGroup);

    /* ---------- 彗体：彗核 + 彗尾（parent 组直接子级，太阳位于 parent 原点） ----------
       彗尾位于彗核背向太阳一侧，由太阳风作用下从彗核抛出的尘埃与气体组成 */
    var cometGroup = new THREE.Group();
    cometGroup.name = 'halleyComet';

    var nucleus = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.2, 1),
      new THREE.MeshStandardMaterial({
        color: 0xd8e6f0, flatShading: true, roughness: 0.5, metalness: 0.1
      })
    );
    nucleus.name = 'halleyNucleus';
    cometGroup.add(nucleus);

    /* 锥体：+Y 为锥尖方向；每帧将 +Y 映射到 -dir（窄端朝彗核、宽端在背日远侧） */

    /* 离子尾（气体）：蓝色、较直、较长（近日点最长 ≈ 2 亿千米） */
    var ionTail = new THREE.Mesh(
      new THREE.ConeGeometry(1, 1, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x8fd0ff, transparent: true, opacity: 0.12,
        side: THREE.DoubleSide, depthWrite: false
      })
    );
    ionTail.name = 'halleyIonTail';
    cometGroup.add(ionTail);

    /* 尘埃尾：暖白色、较宽、较短，方向沿轨道略偏折（模拟弯曲尘尾） */
    var dustTail = new THREE.Mesh(
      new THREE.ConeGeometry(1, 1, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xd8c9a0, transparent: true, opacity: 0.10,
        side: THREE.DoubleSide, depthWrite: false
      })
    );
    dustTail.name = 'halleyDustTail';
    cometGroup.add(dustTail);

    parent.add(cometGroup);

    /* 解开普勒方程 E - e·sinE = M（牛顿迭代，初值 M + e·sinM） */
    function keplerE(M, e) {
      var E = M + e * Math.sin(M);
      for (var it = 0; it < 8; it++) {
        E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      }
      return E;
    }

    /* 由当前平近点角 M 布置彗核位置与彗尾（太阳在原点） */
    var M = 0; // 初始位于近日点
    var _pos = new THREE.Vector3();
    var _dir = new THREE.Vector3();
    var _neg = new THREE.Vector3();
    var _perp = new THREE.Vector3();
    var _dustDir = new THREE.Vector3();
    var UP = new THREE.Vector3(0, 1, 0);
    var _q = new THREE.Quaternion();
    var ORBIT_NORMAL = new THREE.Vector3(0, 1, 0).applyQuaternion(tiltQ); // 轨道面法线

    function placeComet() {
      var Mn = M % TWO_PI;
      if (Mn < 0) Mn += TWO_PI;
      var E = keplerE(Mn, HALLEY_E);

      /* 太阳在焦点：x = a(cosE - e)，z = b·sinE；再按轨道面倾斜变换 */
      _pos.set(
        HALLEY_A * (Math.cos(E) - HALLEY_E),
        0,
        HALLEY_B * Math.sin(E)
      ).applyQuaternion(tiltQ);
      cometGroup.position.copy(_pos);

      /* 彗尾：位于彗核背向太阳一侧（dir = 太阳 → 彗核 方向）；
         长度与日距成反比——近日点长（≈1–2 亿千米）、远日点短 */
      var d = _pos.length();
      _dir.copy(_pos).divideScalar(d);
      /* 锥体 +Y（锥尖/窄端）映射到 -dir：窄端贴彗核、宽端在背日远侧 */
      _q.setFromUnitVectors(UP, _neg.copy(_dir).multiplyScalar(-1));

      /* 离子尾（气体）：较直、较长 */
      var Li = 2100 / d;
      if (Li > 70) Li = 70;   // 近日点 ≈ 2 亿千米（52 单位 = 1 天文单位 ≈ 1.5 亿千米）
      if (Li < 10) Li = 10;
      ionTail.position.copy(_dir).multiplyScalar(Li * 0.5);
      ionTail.scale.set(0.5 + Li * 0.02, Li, 0.5 + Li * 0.02);
      ionTail.quaternion.copy(_q);

      /* 尘埃尾：较宽、较短；方向在背日方向基础上向轨道面内偏折（模拟弯曲尘尾） */
      _perp.crossVectors(ORBIT_NORMAL, _dir);
      _dustDir.copy(_dir).addScaledVector(_perp, 0.22).normalize();
      var Ld = 1400 / d;
      if (Ld > 48) Ld = 48;   // 近日点 ≈ 1.4 亿千米
      if (Ld < 8) Ld = 8;
      dustTail.position.copy(_dustDir).multiplyScalar(Ld * 0.5);
      dustTail.scale.set(0.7 + Ld * 0.045, Ld, 0.7 + Ld * 0.045);
      _q.setFromUnitVectors(UP, _neg.copy(_dustDir).multiplyScalar(-1));
      dustTail.quaternion.copy(_q);
    }

    function update(dt) {
      if (!dt) return;
      /* 逆行：平近点角递减（受全局时间倍率 dps 驱动） */
      M -= (TWO_PI * dps * dt / 1000) / (HALLEY_PERIOD * DAYS_PER_YEAR);
      placeComet();
    }

    placeComet();

    /* 天体注册表条目（拾取 / 聚焦 / 悬浮提示 / 图例联动用） */
    bodies.push({
      key: 'halley', name: '哈雷彗星', type: 'comet',
      mesh: nucleus, radius: 1.2, hex: '#bfe3ff',
      period: HALLEY_PERIOD,
      info: '最著名的周期彗星，公转周期约 75.3 年，逆行轨道（与行星公转方向相反）。' +
        '离心率极高：近日点 0.59 天文单位（水星与金星轨道之间），远日点约 35 天文单位（柯伊伯带区域）。' +
        '彗尾是彗核背向太阳一侧长达 1–2 亿千米的尾巴，由彗核在太阳风作用下抛出的尘埃和气体组成。' +
        '1705 年哈雷依据历史记载预言其回归，1986 年最近一次通过近日点，预计 2061 年再次回归。',
      isSun: false, isMoon: false, isComet: true
    });

    return {
      orbitGroup: orbitGroup,
      cometGroup: cometGroup,
      nucleus: nucleus,
      ionTail: ionTail,
      dustTail: dustTail,
      update: update
    };
  }

  var halley = buildHalley(solarGroup);

  /* ---------- 划过陨石（模块 11：spawnShootingStar / updateShootingStars） ---------- */

  /* 恒定最多 30 颗陨石同时在飞：在太阳系内部（半径 40~280）随机生成，沿直线划过。
     IcosahedronGeometry + 顶点扰动（Vertex Jitter）生成凹凸不平的岩石造型（无尾迹），
     MeshStandardMaterial(flatShading) 面片质感，随机自转，寿命结束自动回收，
     回收时 dispose 释放 Geometry / Material。 */
  var SHOOTING_MAX = 30;           // 同时飞行上限
  var SHOOTING_R_MIN = 40;         // 生成位置半径下限（场景单位）
  var SHOOTING_R_MAX = 280;        // 生成位置半径上限（场景单位）
  var SHOOTING_SPEED = 70;         // 划过速度（场景单位/秒）
  var SHOOTING_LIFE = 8;           // 寿命（真实秒）
  var SHOOTING_SPAWN_EVERY = 250;  // 生成检查间隔（毫秒）

  var shootingGroup = new THREE.Group();
  shootingGroup.name = 'shootingStars';
  solarGroup.add(shootingGroup);

  var shootingStars = [];
  var shootingAcc = 0;             // 生成计时器（毫秒）

  /* 顶点扰动：Icosahedron 为非索引几何体（同一位置的顶点跨面重复），
     用确定性伪随机（同坐标 → 同偏移量）保证重复顶点偏移一致，表面不破裂 */
  function jitterRock(geo, amount) {
    var pos = geo.attributes.position;
    for (var i = 0; i < pos.count; i++) {
      var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      var a = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
      var b = Math.sin(x * 39.425 + y * 11.135 + z * 93.989) * 24634.6345;
      var c = Math.sin(x * 63.727 + y * 45.164 + z * 23.647) * 61234.5864;
      pos.setXYZ(
        i,
        x + (a - Math.floor(a) - 0.5) * amount,
        y + (b - Math.floor(b) - 0.5) * amount,
        z + (c - Math.floor(c) - 0.5) * amount
      );
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  /* 生成一颗陨石：随机位置（球壳内）+ 随机方向（直线）+ 随机自转角速度 */
  function spawnShootingStar() {
    var size = 0.6 + Math.random() * 1.2;

    /* 位置：半径 40~280 球壳内的随机点（球面均匀分布） */
    var r = SHOOTING_R_MIN + Math.random() * (SHOOTING_R_MAX - SHOOTING_R_MIN);
    var theta = Math.random() * TWO_PI;
    var phi = Math.acos(2 * Math.random() - 1);
    var sx = r * Math.sin(phi) * Math.cos(theta);
    var sy = r * Math.cos(phi);
    var sz = r * Math.sin(phi) * Math.sin(theta);

    /* 方向：随机单位向量（直线划过） */
    var dx = Math.random() * 2 - 1;
    var dy = Math.random() * 2 - 1;
    var dz = Math.random() * 2 - 1;
    var dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;

    var geo = new THREE.IcosahedronGeometry(size, 1);
    jitterRock(geo, size * 0.45);
    var mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(
        0.06 + Math.random() * 0.08,      // 色相：黄褐~褐（石头色调）
        0.05 + Math.random() * 0.15,      // 饱和度：低（灰调，像石头）
        0.25 + Math.random() * 0.20       // 明度：中低（石色深浅）
      ),
      flatShading: true, roughness: 0.9, metalness: 0.1
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'shooting:' + shootingStars.length;
    mesh.position.set(sx, sy, sz);
    shootingGroup.add(mesh);

    shootingStars.push({
      mesh: mesh,
      vx: dx / dl * SHOOTING_SPEED,
      vy: dy / dl * SHOOTING_SPEED,
      vz: dz / dl * SHOOTING_SPEED,
      life: SHOOTING_LIFE,
      spinX: (Math.random() - 0.5) * 2,
      spinY: (Math.random() - 0.5) * 2,
      spinZ: (Math.random() - 0.5) * 2
    });
  }

  /* 每帧更新：生成控制（恒定 ≤ 30）+ 直线运动 + 自转 + 寿命回收 */
  function updateShootingStars(dtMs) {
    if (!dtMs) return;
    var dt = dtMs / 1000;

    /* 生成控制：间隔 250ms 检查一次，未满 30 颗则补生 */
    shootingAcc += dtMs;
    while (shootingAcc >= SHOOTING_SPAWN_EVERY) {
      shootingAcc -= SHOOTING_SPAWN_EVERY;
      if (shootingStars.length < SHOOTING_MAX) spawnShootingStar();
    }

    /* 运动 / 自转 / 寿命；过期则移出场景并释放几何体与材质 */
    for (var i = shootingStars.length - 1; i >= 0; i--) {
      var s = shootingStars[i];
      s.life -= dt;
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.y += s.vy * dt;
      s.mesh.position.z += s.vz * dt;
      s.mesh.rotation.x += s.spinX * dt;
      s.mesh.rotation.y += s.spinY * dt;
      s.mesh.rotation.z += s.spinZ * dt;
      if (s.life <= 0) {
        shootingGroup.remove(s.mesh);
        s.mesh.geometry.dispose();
        s.mesh.material.dispose();
        shootingStars.splice(i, 1);
      }
    }
  }

  /* 首批 10 颗，页面加载即有陨石划过 */
  var si;
  for (si = 0; si < 10; si++) {
    spawnShootingStar();
  }

  /* ---------- 拾取 / 聚焦 / 悬停 ---------- */

  var raycaster = new THREE.Raycaster();
  var pointer = new THREE.Vector2();
  var pickMeshes = [];
  var k;
  for (k = 0; k < bodies.length; k++) pickMeshes.push(bodies[k].mesh);

  var focusTarget = null;
  var camTarget = new THREE.Vector3(0, 0, 0);
  var desiredDist = null;

  var dom = renderer.domElement;
  var downX = 0, downY = 0, downT = 0;

  function eventPos(e) {
    var rect = dom.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function pickAt(e) {
    eventPos(e);
    raycaster.setFromCamera(pointer, camera);
    var hits = raycaster.intersectObjects(pickMeshes, false);
    if (hits.length) return findBody(hits[0].object);
    return null;
  }

  function findBody(obj) {
    var j;
    for (j = 0; j < bodies.length; j++) {
      if (bodies[j].mesh === obj) return bodies[j];
    }
    return null;
  }

  var listItems = {}; // key -> <li>

  /* 模块 16：信息浮窗 —— 动态创建 tooltip 元素（DOM 创建与管理），
     样式沿用 css/style.css 中的 .tooltip 类 */
  function createTooltip() {
    var el = document.createElement('div');
    el.id = 'tooltip';
    el.className = 'tooltip';
    document.body.appendChild(el);
    return el;
  }

  var tooltip = createTooltip();

  function showTooltip(e, body) {
    if (!tooltip) return;
    /* 周期以地球时间为基准：行星用地球年，月球用地球日（绕地周期） */
    var label, value;
    if (body.isSun) {
      label = '类型';
      value = '恒星';
    } else if (body.isMoon) {
      label = '绕地周期';
      value = (body.period * DAYS_PER_YEAR).toFixed(1) + ' 地球日';
    } else {
      label = '公转周期';
      value = body.period.toFixed(2) + ' 地球年';
    }
    var rows = '<div class="t-row"><span>' + label + '</span><span>' + value + '</span></div>';
    tooltip.innerHTML =
      '<div class="t-title" style="color:' + cssColor(body.hex) + '">' + body.name + '</div>' +
      rows +
      '<div style="margin-top:4px;color:#9fb4d8">' + body.info + '</div>';
    tooltip.style.opacity = '1';

    /* 定位：跟随点击 / 光标位置；用 getBoundingClientRect 实测浮窗尺寸，
       靠窗口边缘时翻转到另一侧，仍越界则钳制，确保不超出窗口 */
    var GAP = 14;      // 与光标的间距
    var MARGIN = 8;    // 距窗口边缘的最小留白
    var rect = tooltip.getBoundingClientRect();
    var x = e.clientX + GAP;
    var y = e.clientY + GAP;
    if (x + rect.width > window.innerWidth - MARGIN) x = e.clientX - GAP - rect.width;
    if (y + rect.height > window.innerHeight - MARGIN) y = e.clientY - GAP - rect.height;
    if (x < MARGIN) x = MARGIN;
    if (y < MARGIN) y = MARGIN;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }

  function hideTooltip() {
    if (tooltip) tooltip.style.opacity = '0';
  }

  function focusOn(body) {
    focusTarget = body;
    desiredDist = Math.max(body.radius * 4.2, 14);
    highlightLegend(body);   // 双向联动：高亮对应图例条目
  }

  function unfocus() {
    focusTarget = null;
    desiredDist = null;
    highlightLegend(null);   // 清除图例高亮
  }

  /* 画布单击（区分点击与拖拽）：THREE.Raycaster 射线拾取天体。
     命中 → 聚焦 + 显示信息浮窗 + 高亮图例条目；
     未命中（空白区域）→ 解除聚焦 + 隐藏信息浮窗 */
  function onCanvasClick(clientX, clientY) {
    var dx = clientX - downX, dy = clientY - downY;
    if (dx * dx + dy * dy > 36) return;              // 拖拽不触发拾取
    if (Date.now() - downT > 600) return;
    var rect = dom.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    var hits = raycaster.intersectObjects(pickMeshes, false);
    if (hits.length) {
      var body = findBody(hits[0].object);
      focusOn(body);   // 含图例高亮（highlightLegend）
      showTooltip({ clientX: clientX, clientY: clientY }, body);
    } else {
      unfocus();
      hideTooltip();
    }
  }

  /* ---------- UI ---------- */

  var uiSpeed = $('speed');
  var uiSpeedValue = $('speed-value');
  var uiRotate = $('rotate-speed');
  var uiRotateValue = $('rotate-value');
  var btnPause = $('btn-pause');
  var btnReset = $('btn-reset');
  var btnViewFront = $('btn-view-front');
  var btnViewTop = $('btn-view-top');
  var btnViewSide = $('btn-view-side');
  var legendList = $('legend-list');

  function speedText() {
    return Math.round(dps) + ' 天/秒';
  }

  function applySpeed(v) {
    dps = v / 10; // 0–1000 → 0–100 天/秒
    if (uiSpeedValue) uiSpeedValue.textContent = speedText();
  }

  /* 太阳系旋转倍速滑杆（模块 12）：0~20（0 = 停止），实时驱动 solarGroup 绕 Y 轴旋转 */
  function applyRotate(v) {
    solarSpin = v;
    if (uiRotateValue) uiRotateValue.textContent = Math.round(v) + 'x';
  }

  /* 模块 14：视角控制（视图模块）
     切换视角：先解除聚焦，再 camera.position.set + controls.target / update
     （太阳系位于 XZ 平面，目标点回到原点） */
  function goToView(pos) {
    unfocus();
    camera.position.set(pos.x, pos.y, pos.z);
    camTarget.set(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.update();
  }

  /* ---------- 模块 17：图例与联动（buildLegend / focusLegend / highlightLegend） ---------- */

  /* 图例条目 meta 文案：恒星 / 公转周期 / 月球绕地周期 */
  function metaText(body) {
    if (body.isSun) return '恒星';
    if (body.isMoon) return (body.period * DAYS_PER_YEAR).toFixed(1) + ' 天';
    return body.period.toFixed(2) + ' 年';
  }

  /* 按名称查找天体（data-name 属性驱动） */
  function bodyByName(name) {
    for (var b = 0; b < bodies.length; b++) {
      if (bodies[b].name === name) return bodies[b];
    }
    return null;
  }

  /* 动态构建一个图例条目（data-name / data-type 属性驱动） */
  function makeLegendItem(body) {
    var li = document.createElement('li');
    li.setAttribute('data-name', body.name);
    li.setAttribute('data-type', body.isSun ? 'star' : (body.isMoon ? 'moon' : 'planet'));

    var sw = document.createElement('span');
    sw.className = 'dot';
    sw.style.background = cssColor(body.hex);

    var nm = document.createElement('span');
    nm.className = 'name';
    nm.textContent = body.name;

    var meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = metaText(body);

    li.appendChild(sw);
    li.appendChild(nm);
    li.appendChild(meta);

    wireLegendItem(li, body);
    return li;
  }

  /* 图例条目交互：点击 → focusLegend（视角聚焦 + 跟随）；悬停 → 信息浮窗 */
  function wireLegendItem(li, body) {
    li.addEventListener('click', function () {
      focusLegend(body);
    });
    li.addEventListener('mouseenter', function (e) {
      showTooltip(e, body);
    });
    li.addEventListener('mouseleave', hideTooltip);
    listItems[body.key] = li;
  }

  /* 点击图例条目：视角自动聚焦到对应天体并跟随
     （跟随逻辑：主循环 step() 中 controls.target 逐帧 lerp 到天体世界坐标） */
  function focusLegend(body) {
    focusOn(body);
  }

  /* 高亮对应图例条目（双向联动，classList 切换 selected）；传 null 清除高亮 */
  function highlightLegend(body) {
    for (var k2 in listItems) {
      if (Object.prototype.hasOwnProperty.call(listItems, k2)) {
        listItems[k2].classList.toggle('selected', body !== null && k2 === body.key);
      }
    }
  }

  /* 生成图例（右侧面板）：太阳（恒星）、八大行星、月球（卫星）。
     HTML 已预置条目（data-name / data-type 驱动）时直接绑定交互，
     否则按 SOLAR_DATA 动态生成（兜底） */
  function buildLegend() {
    if (!legendList) return;
    var existing = legendList.querySelectorAll('li[data-name]');
    var wired = 0;
    for (var i = 0; i < existing.length; i++) {
      var body = bodyByName(existing[i].getAttribute('data-name'));
      if (body) {
        wireLegendItem(existing[i], body);
        wired++;
      }
    }
    if (!wired) {
      for (var j = 0; j < bodies.length; j++) {
        legendList.appendChild(makeLegendItem(bodies[j]));
      }
    }
  }

  /* ---------- 模块 18：科普知识面板（buildBeltPanel） ---------- */

  /* 科普内容：data-zone 对应 3D 场景闪烁区域（flashZone） */
  var BELT_FACTS = [
    {
      zone: 'asteroid',
      title: '小行星带',
      text: '位于火星与木星轨道之间，由数十万颗以上 1 公里级以上的小行星组成。' +
        '由于木星强大的引力扰动，这里的星子始终无法聚合成一颗行星。' +
        '整个小行星带的总质量仅约为月球质量的 3%，' +
        '最大成员“谷神星”已于 2006 年被归类为矮行星。'
    },
    {
      zone: 'kuiper',
      title: '柯伊伯带',
      text: '分布在海王星轨道之外（约 30–55 个天文单位）的环状区域，' +
        '主要由冰、岩石和冻结挥发物构成，是短周期彗星的重要来源。' +
        '冥王星便是其中著名的成员。该带由天文学家柯伊伯于 1951 年预言存在，' +
        '1992 年人类正式发现第一颗柯伊伯带天体。'
    },
    {
      zone: 'scattered',
      title: '离散盘',
      text: '位于柯伊伯带外侧（延伸至约 50–100 个天文单位以上）的稀疏区域，' +
        '成员轨道离心率极高、倾角很大，是被海王星引力扰动"散射"到远空的天体，' +
        '也是长周期彗星的重要来源。' +
        '矮行星"阋神星"是其中最大的成员之一，质量略大于冥王星。'
    }
  ];

  /* 动态 HTML 拼接生成左侧科普面板，
     每个科普框点击 → flashZone(zone) 闪烁对应天体区域 */
  function buildBeltPanel() {
    var panel = $('belt-panel');
    if (!panel) return;
    var html = '<h2>太阳系科普小知识</h2>' +
      '<div class="hint">点击科普框可在 3D 视图中定位对应区域</div>';
    for (var i = 0; i < BELT_FACTS.length; i++) {
      var f = BELT_FACTS[i];
      html += '<section class="fact-box" data-zone="' + f.zone + '">' +
        '<h3>' + f.title + '</h3>' +
        '<p>' + f.text + '</p>' +
        '</section>';
    }
    panel.innerHTML = html;

    var boxes = panel.querySelectorAll('.fact-box[data-zone]');
    for (var b = 0; b < boxes.length; b++) {
      boxes[b].addEventListener('click', function () {
        flashZone(this.getAttribute('data-zone'));
      });
    }
  }

  /* ---------- 模块 19：区域闪烁提示（flashZone / updateFlash） ---------- */

  /* 点击科普框：对应区域内所有小天体集体脉冲放大 + 变亮闪烁约 2.4 秒，结束后自动还原。
     正弦脉冲动画（(sin+1)/2 平滑）：起止均为 0，FLASH_PULSES 个完整周期；
     临时修改 scale 与材质颜色，结束后还原为初始状态 */
  var FLASH_LIFE = 2.4;        // 闪烁时长（真实秒）
  var FLASH_PULSES = 3;        // 脉冲次数
  var FLASH_SCALE_AMP = 0.6;   // 放大峰值（+60%）
  var FLASH_BRIGHT = 0.75;     // 变亮强度（向白色插值系数峰值）
  var FLASH_WHITE = new THREE.Color(0xffffff);
  var flashes = [];

  function flashZone(zone) {
    var list = null;
    if (zone === 'asteroid') {
      list = meteorBelt.rocks;      // 小行星带 300 颗岩石
    } else if (zone === 'kuiper') {
      list = kuiperBelt.ices;       // 柯伊伯带 400 颗小天体
    } else if (zone === 'scattered') {
      list = scatteredDisc.ices;    // 离散盘 200 颗冰质天体
    }
    if (!list || !list.length) return;

    /* 同区域正在闪烁时，直接重启动画 */
    for (var d = 0; d < flashes.length; d++) {
      if (flashes[d].zone === zone) {
        flashes[d].t = 0;
        return;
      }
    }

    /* 记录每个网格的原始颜色与原始缩放（结束还原用；
       缩放按基值乘系数，避免覆盖网格的动态缩放 */
    var baseColors = [];
    var baseScales = [];
    for (var i = 0; i < list.length; i++) {
      baseColors.push(list[i].mesh.material.color.clone());
      baseScales.push(list[i].mesh.scale.clone());
    }

    flashes.push({ zone: zone, list: list, baseColors: baseColors, baseScales: baseScales, t: 0 });
  }

  /* 每步更新闪烁动画：脉冲放大 + 变亮；p ≥ 1 时还原 scale / 颜色并结束 */
  function updateFlash(dtMs) {
    if (!dtMs) return;
    for (var i = flashes.length - 1; i >= 0; i--) {
      var f = flashes[i];
      f.t += dtMs / 1000;
      var p = Math.min(f.t / FLASH_LIFE, 1);

      /* 正弦脉冲（(sin+1)/2 平滑）：-π/2 相移使 p=0 与 p=1 时均为 0 */
      var pulse = (Math.sin(Math.PI * FLASH_PULSES * p - Math.PI / 2) + 1) / 2;

      for (var j = 0; j < f.list.length; j++) {
        var mesh = f.list[j].mesh;
        if (p >= 1) {
          /* 动画结束：还原 scale 与材质颜色 */
          mesh.scale.copy(f.baseScales[j]);
          mesh.material.color.copy(f.baseColors[j]);
        } else {
          /* 脉冲放大（在原始缩放基础上乘系数）+ 变亮（颜色向白色插值） */
          mesh.scale.copy(f.baseScales[j]).multiplyScalar(1 + FLASH_SCALE_AMP * pulse);
          mesh.material.color.copy(f.baseColors[j]).lerp(FLASH_WHITE, FLASH_BRIGHT * pulse);
        }
      }

      if (p >= 1) flashes.splice(i, 1);
    }
  }

  /* ---------- 模块 15：交互事件（bindEvents / onCanvasClick） ---------- */

  /* 集中绑定全部交互事件（addEventListener）：
     按钮（暂停 / 重置视角 / 标准视角）+ 滑杆（时间倍速 / 旋转倍速）
     + 画布（单击拾取、悬停提示）+ 图例条目 + resize 自适应 */
  function bindEvents() {
    /* --- 画布：按下记录（区分点击与拖拽） --- */
    dom.addEventListener('mousedown', function (e) {
      downX = e.clientX; downY = e.clientY; downT = Date.now();
    });
    dom.addEventListener('touchstart', function (e) {
      if (e.touches && e.touches.length) {
        downX = e.touches[0].clientX; downY = e.touches[0].clientY; downT = Date.now();
      }
    }, { passive: true });

    /* --- 画布：单击天体 → 聚焦 + 信息浮窗；单击空白 → 隐藏浮窗 --- */
    dom.addEventListener('mouseup', function (e) { onCanvasClick(e.clientX, e.clientY); });
    dom.addEventListener('touchend', function (e) {
      if (e.changedTouches && e.changedTouches.length) {
        onCanvasClick(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      }
    }, { passive: true });

    /* --- 悬停提示（限流） --- */
    var lastHover = 0;
    dom.addEventListener('mousemove', function (e) {
      var now = Date.now();
      if (now - lastHover < 40) return;
      lastHover = now;
      var body = pickAt(e);
      if (body) {
        showTooltip(e, body);
        dom.style.cursor = 'pointer';
      } else {
        hideTooltip();
        dom.style.cursor = 'default';
      }
    });
    dom.addEventListener('mouseleave', function () {
      hideTooltip();
      dom.style.cursor = 'default';
    });

    /* --- 按钮：暂停/继续切换 --- */
    if (btnPause) {
      btnPause.addEventListener('click', function () {
        paused = !paused;
        btnPause.textContent = paused ? '继续' : '暂停';
        btnPause.classList.toggle('active', paused);
      });
    }

    /* --- 按钮：重置视角 + 三种标准视角（模块 14） --- */
    if (btnReset) {
      btnReset.addEventListener('click', function () {
        /* 重置视角：恢复默认相机位置 */
        goToView(HOME_POS);
      });
    }
    if (btnViewFront) {
      btnViewFront.addEventListener('click', function () {
        /* 正视 (0, 10, 96)：从 Z 轴正面观察 */
        goToView(new THREE.Vector3(0, 10, 96));
      });
    }
    if (btnViewTop) {
      btnViewTop.addEventListener('click', function () {
        /* 俯视 (0, 96, 8)：从上方俯瞰黄道面（带微小 Z 偏移避免相机极点奇异） */
        goToView(new THREE.Vector3(0, 96, 8));
      });
    }
    if (btnViewSide) {
      btnViewSide.addEventListener('click', function () {
        /* 侧视 (96, 10, 0)：从 X 轴侧面观察 */
        goToView(new THREE.Vector3(96, 10, 0));
      });
    }

    /* --- 滑杆：时间倍速（0–1000 → 0–100 天/秒） --- */
    if (uiSpeed) {
      uiSpeed.addEventListener('input', function () {
        applySpeed(parseFloat(uiSpeed.value));
      });
    }
    applySpeed(parseFloat(uiSpeed ? uiSpeed.value : 400));

    /* --- 滑杆：太阳系旋转倍速（模块 12，0~20） --- */
    if (uiRotate) {
      uiRotate.addEventListener('input', function () {
        applyRotate(parseFloat(uiRotate.value));
      });
    }
    applyRotate(parseFloat(uiRotate ? uiRotate.value : 10));

    /* --- 用户直接操作相机（拖拽/滚轮）时，解除“期望距离”约束 --- */
    if (typeof controls.addEventListener === 'function') {
      controls.addEventListener('start', function () {
        desiredDist = null;
      });
    }

    /* --- 科普知识面板：动态生成 + 点击闪烁区域（模块 18：buildBeltPanel） --- */
    buildBeltPanel();

    /* --- 图例：生成条目 + 双向联动（模块 17：buildLegend） --- */
    buildLegend();

    /* --- 窗口尺寸变化：自适应相机与渲染器 --- */
    window.addEventListener('resize', function () {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  bindEvents();

  /* ---------- 主循环（模块 13：animate） ---------- */

  var lastT = Date.now();
  var started = false;
  var _pos = new THREE.Vector3();

  var FIXED_STEP = 16.7;  // 固定步长（毫秒，≈1/60 秒）
  var timeAcc = 0;        // 帧时间累加器（毫秒）

  /* 单步固定步长模拟（dt = FIXED_STEP，毫秒）：
     三角函数（cos/sin 组旋转）计算公转 / 自转位置 */
  function step(dt) {
    /* 星空缓慢自转 + 星星闪烁效果更新 */
    starField.update(dt);

    /* 太阳：日冕呼吸脉动 + 耀斑爆发（自身发光，不随模拟暂停而停止） */
    sunUpdate(dt);

    /* 模块 12：太阳系整体绕 Y 轴持续旋转（实时驱动，速率 = 基础角速度 × 滑杆倍速） */
    solarGroup.rotation.y += SOLAR_SPIN_BASE * solarSpin * dt * 0.001;

    /* 模块 19：区域闪烁提示动画（不随模拟暂停而停止） */
    updateFlash(dt);

    if (!paused) {
      var orbitOmega = (TWO_PI * dps / DAYS_PER_YEAR) / 1000; // 弧度/毫秒（1 地球年基准）
      var j;

      /* 太阳自转 */
      sun.rotation.y += SPIN_VIS * dps * 0.05 * dt;

      /* 行星：公转（orbitGroup 旋转）+ 自转（mesh 旋转） */
      for (j = 0; j < planets.length; j++) {
        var pl = planets[j];
        pl.orbitGroup.rotation.y += (orbitOmega / Math.max(pl.data.period, 0.05)) * dt;
        pl.mesh.rotation.y += SPIN_VIS * dps * (pl.data.spin || 0.2) * dt;

        /* 月球：绕地公转（moonGroup 旋转） */
        if (pl.moon) {
          pl.moon.group.rotation.y += (orbitOmega / Math.max(pl.moon.data.period, 0.05)) * dt;
        }
      }

      /* 小行星带：绕太阳公转 + 自转 */
      meteorBelt.update(dt);

      /* 柯伊伯带：缓慢公转 + 自转 */
      kuiperBelt.update(dt);

      /* 离散盘：缓慢公转 + 自转 */
      scatteredDisc.update(dt);

      /* 哈雷彗星：开普勒轨道运动（逆行）+ 彗尾背向太阳 */
      halley.update(dt);

      /* 划过陨石：生成 + 直线运动 + 自转 + 寿命回收 */
      updateShootingStars(dt);
    }

    /* 聚焦跟随 */
    if (focusTarget) {
      focusTarget.mesh.getWorldPosition(_pos);
      camTarget.lerp(_pos, 0.12);
      if (desiredDist !== null) {
        var dir = new THREE.Vector3().subVectors(camera.position, _pos);
        var len = dir.length();
        if (Math.abs(len - desiredDist) > 0.05) {
          var nl = len + (desiredDist - len) * 0.08;
          camera.position.copy(_pos).add(dir.multiplyScalar(nl / len));
        }
      }
    }
    controls.target.lerp(camTarget, 0.25);
    if (controls) controls.update();
  }

  function animate() {
    requestAnimationFrame(animate);
    var now = Date.now();
    var frame = Math.min(now - lastT, 100); // 单帧时间封顶，防止后台切回产生巨步长
    lastT = now;
    timeAcc += frame;

    /* 固定步长 dt 模拟时间流逝（每帧 1~N 步） */
    while (timeAcc >= FIXED_STEP) {
      timeAcc -= FIXED_STEP;
      step(FIXED_STEP);
    }

    /* 最后渲染画面 */
    renderer.render(scene, camera);

    /* 首帧完成后收起加载页 */
    if (!started) {
      started = true;
      var ld = $('loading');
      if (ld) {
        ld.classList.add('hidden');
        setTimeout(function () { ld.style.display = 'none'; }, 600);
      }
    }
  }
  animate();

  /* ---------- 启动日志 ---------- */

  console.log('[Solar System] three.js ' + THREE.REVISION + ' 已启动，天体数量：' + bodies.length +
    '，默认速度：' + speedText());
}());
