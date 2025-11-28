const path = require('path');
const fs = require('fs-extra');

const dataDir = path.join(__dirname, '..', '..', 'data');
const routersPath = path.join(dataDir, 'routers.json');

async function ensureStore() {
  await fs.ensureDir(dataDir);
  if (!(await fs.pathExists(routersPath))) {
    await fs.writeJSON(routersPath, [], { spaces: 2 });
  }
}

async function getRouters() {
  await ensureStore();
  return fs.readJSON(routersPath);
}

async function saveRouters(list) {
  await ensureStore();
  await fs.writeJSON(routersPath, list, { spaces: 2 });
}

async function addRouter(router) {
  const routers = await getRouters();
  if (routers.some((r) => r.name === router.name)) {
    throw new Error('Nama router sudah digunakan');
  }
  routers.push(router);
  await saveRouters(routers);
  return router;
}

async function removeRouter(name) {
  const routers = await getRouters();
  const filtered = routers.filter((r) => r.name !== name);
  if (filtered.length === routers.length) {
    throw new Error('Router tidak ditemukan');
  }
  await saveRouters(filtered);
}

module.exports = {
  getRouters,
  addRouter,
  removeRouter,
};

