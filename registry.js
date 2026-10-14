// ============================================
// registry.js
// ============================================

window.TEST_REGISTRY  = [];
window.CONFIG         = null;
window.SITES_CONFIG   = null;
window.GEOPOINTS      = [];
window.SCHEDULES      = [];
window.TEST_SETS      = [];

window.setTestRegistry  = (tests) => { window.TEST_REGISTRY = tests; };
window.setConfig        = (cfg)   => { window.CONFIG = cfg; };
window.setSitesConfig   = (data)  => { window.SITES_CONFIG = data; };
window.setGeopoints     = (list)  => { window.GEOPOINTS = list; };
window.setSchedules     = (list)  => { window.SCHEDULES = list; };
window.setTestSets      = (list)  => { window.TEST_SETS = list; };

console.log('✅ Registry инициализирован');