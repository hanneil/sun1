/* ============================================================
 * 天体数据定义（模块 3）
 * 全局对象 window.SOLAR_DATA，后续模块均基于此数据生成天体。
 *
 * 字段说明：
 *   radius      天体半径（场景单位，压缩比例）
 *   orbitRadius 轨道半径（场景单位，压缩比例）
 *   orbitSpeed  公转速度（真实值，km/s，用于科普展示）
 *   axialTilt   自转轴倾角（度，真实值）
 *   period      公转周期（地球年）
 *   spin        自转视觉系数（相对地球，用于动画）
 *   ring        光环标记（仅土星）
 *   moon        卫星子数据（仅地球含月球）
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- 月球（地球卫星） ---------- */

  var MOON = {
    key: 'moon',
    name: '月球',
    type: 'satellite',
    color: '#c9c9c9',
    radius: 0.8,
    orbitRadius: 6,
    orbitSpeed: 1.0,
    period: 0.0748,   // 绕地周期 ≈ 27.3 地球日（恒星月），1 地球年约绕地 13.4 圈
    info: '地球唯一的天然卫星，潮汐锁定，始终以同一面朝向地球'
  };

  /* ---------- 全局数据 ---------- */

  window.SOLAR_DATA = {
    /* 太阳（恒星） */
    sun: {
      key: 'sun',
      name: '太阳',
      type: 'star',
      color: '#ffcc44',
      radius: 12,
      info: '太阳系的中心恒星，占系统总质量的 99.86%；' +
        '表面是狂暴沸腾的发光等离子体：密密麻麻的米粒组织、深色太阳黑子，' +
        '边缘喷吐红色日珥、爆发耀斑，银白色日冕不断向外流动'
    },

    /* 八大行星（由近及远） */
    planets: [
      {
        key: 'mercury',
        name: '水星',
        type: 'planet',
        color: '#9c8e84',
        radius: 1.6,
        orbitRadius: 26,
        orbitSpeed: 47.4,
        axialTilt: 0.03,
        period: 0.24,
        spin: 0.02,
        info: '距太阳最近的行星，昼夜温差极大，几乎没有大气；' +
          '表面呈冷峻灰白色调，粗糙斑驳，布满大小不一、深浅不一的碗状环形山，坑底深灰、坑缘微亮',
        ring: null,
        moon: null
      },
      {
        key: 'venus',
        name: '金星',
        type: 'planet',
        color: '#e6c46a',
        radius: 2.9,
        orbitRadius: 38,
        orbitSpeed: 35.0,
        axialTilt: 177.4,
        period: 0.62,
        spin: 0.01,
        info: '浓密二氧化碳大气，强温室效应，表面温度全太阳系最高；' +
          '表面被柔软流动的带状云雾覆盖，呈斜向 V 形/波浪交织（如奶油拉花、大理石纹），' +
          '底色奶白奶油，局部黄褐暗红褐斑块如水彩晕染，柔软朦胧',
        ring: null,
        moon: null
      },
      {
        key: 'earth',
        name: '地球',
        type: 'planet',
        color: '#3d78c8',
        radius: 3.1,
        orbitRadius: 52,
        orbitSpeed: 29.8,
        axialTilt: 23.4,
        period: 1.0,
        spin: 1.0,
        info: '目前已知唯一存在生命的行星，表面约 71% 被海洋覆盖；' +
          '深邃蔚蓝如巨大蓝宝石，翠绿与土黄大陆板块、纯白极地冰盖，' +
          '白色云系漩涡与台风漂浮其上，边缘环绕极薄明亮的淡蓝大气光晕',
        ring: null,
        moon: MOON
      },
      {
        key: 'mars',
        name: '火星',
        type: 'planet',
        color: '#c1553b',
        radius: 2.2,
        orbitRadius: 68,
        orbitSpeed: 24.1,
        axialTilt: 25.2,
        period: 1.88,
        spin: 1.03,
        info: '红色源于地表氧化铁，如风化了亿万年的巨大生锈铁块；' +
          '干涸粗糙、布满粉尘砂砾的荒漠戈壁；两极有纯白冰盖如两顶白帽；' +
          '表面斑驳——深褐色古老火山岩平原与红橙色沙尘高地交织，' +
          '散布环形山、暗色峡谷与巨大火山（"奥林帕斯山"为太阳系最高火山）',
        ring: null,
        moon: null
      },
      {
        key: 'jupiter',
        name: '木星',
        type: 'planet',
        color: '#c8a06a',
        radius: 8.5,
        orbitRadius: 112,
        orbitSpeed: 13.1,
        axialTilt: 3.1,
        period: 11.86,
        spin: 2.4,
        info: '太阳系最大行星，气态巨行星；表面光滑流动如油画颜料被风吹拂拉扯，' +
          '奶白/米黄/浅棕底色，红褐赤橙灰褐呈横向条带翻滚交织；' +
          '"大红斑"是持续数百年的橙红色大风暴，云带间点缀亮白色风暴气旋',
        ring: null,
        moon: null
      },
      {
        key: 'saturn',
        name: '土星',
        type: 'planet',
        color: '#d9c08a',
        radius: 7.4,
        orbitRadius: 152,
        orbitSpeed: 9.7,
        axialTilt: 26.7,
        period: 29.46,
        spin: 2.2,
        info: '拥有壮观的同心细带光环（亮白至浅灰褐、含卡西尼缝），如巨大黑胶唱片般向外展开；' +
          '自转极快呈扁球体，表面奶油白/淡黄/浅金棕柔和条纹、宁静朦胧；' +
          '球体与光环互相遮挡、互相投影，平均密度低于水',
        ring: { inner: 9.5, outer: 17.5 },
        moon: null
      },
      {
        key: 'uranus',
        name: '天王星',
        type: 'planet',
        color: '#7fc4cf',
        radius: 4.6,
        orbitRadius: 196,
        orbitSpeed: 6.8,
        axialTilt: 97.8,
        period: 84.0,
        spin: 1.4,
        info: '自转轴几乎躺倒，"侧躺"着公转的冰巨行星；' +
          '均匀通透的冰蓝色（青绿/蓝绿），宛如无瑕淡青玉石、冰封深海；' +
          '表面丝滑光滑，至多隐约可见极微弱的横向淡色云带，冰冷寂静、高冷遗世独立',
        ring: null,
        moon: null
      },
      {
        key: 'neptune',
        name: '海王星',
        type: 'planet',
        color: '#3f66d4',
        radius: 4.4,
        orbitRadius: 236,
        orbitSpeed: 5.4,
        axialTilt: 28.3,
        period: 164.8,
        spin: 1.5,
        info: '太阳系最外侧行星，风速最快，可达 2100 km/h；' +
          '深邃蔚蓝、深钴蓝、宝石蓝，如深不可测的蓝宝石；' +
          '亮白/浅蓝丝带云带飘舞，暗蓝色带与大暗斑、明暗相间气旋交织，明暗对比强烈，大气极度狂暴',
        ring: null,
        moon: null
      }
    ]
  };
})();
