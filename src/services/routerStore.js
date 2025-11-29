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
  try {
    const routers = await fs.readJSON(routersPath);
    // Validate that it's an array
    if (!Array.isArray(routers)) {
      console.warn('routers.json is not an array, resetting to empty array');
      await saveRouters([]);
      return [];
    }
    return routers;
  } catch (err) {
    // If JSON is corrupted, reset to empty array
    if (err.name === 'SyntaxError' || err.code === 'ENOENT') {
      console.warn('routers.json is corrupted or missing, resetting to empty array');
      await saveRouters([]);
      return [];
    }
    throw err;
  }
}

async function saveRouters(list) {
  await ensureStore();
  await fs.writeJSON(routersPath, list, { spaces: 2 });
}

async function addRouter(router) {
  // Validate required fields
  if (!router || typeof router !== 'object') {
    throw new Error('Data router tidak valid');
  }
  if (!router.name || !router.host || !router.username || !router.password) {
    throw new Error('Router harus memiliki name, host, username, dan password');
  }
  
  // Validate name is not empty after trimming
  if (!router.name.trim()) {
    throw new Error('Nama router tidak boleh kosong');
  }
  
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

