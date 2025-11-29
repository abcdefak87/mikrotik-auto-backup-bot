const path = require('path');
const fs = require('fs-extra');

const dataDir = path.join(__dirname, '..', '..', 'data');
const routersPath = path.join(dataDir, 'routers.json');

// Simple queue-based locking mechanism to prevent race conditions
let writeQueue = Promise.resolve();

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
  // Use queue to prevent concurrent writes (race condition fix)
  writeQueue = writeQueue.then(async () => {
    // Write to temporary file first, then rename (atomic operation)
    const tempPath = `${routersPath}.tmp`;
    await fs.writeJSON(tempPath, list, { spaces: 2 });
    // Use rename for atomic operation (works on most filesystems)
    if (await fs.pathExists(routersPath)) {
      await fs.remove(routersPath);
    }
    await fs.rename(tempPath, routersPath);
  }).catch((err) => {
    console.error('Error saving routers:', err);
    // Clean up temp file if it exists
    fs.remove(`${routersPath}.tmp`).catch(() => {});
    throw err;
  });
  await writeQueue;
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
  const trimmedName = router.name.trim();
  if (!trimmedName) {
    throw new Error('Nama router tidak boleh kosong');
  }
  
  // Normalize name for duplicate check (case-insensitive, trimmed)
  router.name = trimmedName;
  
  // Use queue to prevent race condition when reading and writing
  return new Promise((resolve, reject) => {
    writeQueue = writeQueue.then(async () => {
      try {
        const routers = await getRouters();
        // Check for duplicate (case-insensitive)
        if (routers.some((r) => r.name && r.name.trim().toLowerCase() === trimmedName.toLowerCase())) {
          throw new Error('Nama router sudah digunakan');
        }
        routers.push(router);
        await saveRouters(routers);
        resolve(router);
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function removeRouter(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Nama router tidak valid');
  }
  
  // Normalize name (trim and case-insensitive matching like addRouter)
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('Nama router tidak boleh kosong');
  }
  
  // Use queue to prevent race condition when reading and writing
  return new Promise((resolve, reject) => {
    writeQueue = writeQueue.then(async () => {
      try {
        const routers = await getRouters();
        console.warn(`[removeRouter] Current routers count: ${routers.length}`);
        console.warn(`[removeRouter] Looking for router: "${trimmedName}"`);
        
        // Use case-insensitive matching with trim (same as addRouter duplicate check)
        const filtered = routers.filter((r) => {
          if (!r.name) return true; // Keep routers without name (shouldn't happen, but safe)
          const routerName = r.name.trim().toLowerCase();
          const targetName = trimmedName.toLowerCase();
          const matches = routerName === targetName;
          if (matches) {
            console.warn(`[removeRouter] Found matching router: "${r.name}" (original: "${r.name}")`);
          }
          return !matches; // Keep routers that don't match
        });
        
        console.warn(`[removeRouter] Filtered routers count: ${filtered.length}`);
        
        if (filtered.length === routers.length) {
          console.warn(`[removeRouter] Router not found. Available routers:`, routers.map(r => `"${r.name}"`).join(', '));
          throw new Error('Router tidak ditemukan');
        }
        
        await saveRouters(filtered);
        console.warn(`[removeRouter] Router "${trimmedName}" successfully removed`);
        resolve();
      } catch (err) {
        console.error(`[removeRouter] Error:`, err.message || err);
        reject(err);
      }
    }).catch((err) => {
      // Catch any errors from the queue chain
      console.error(`[removeRouter] Queue error:`, err.message || err);
      reject(err);
    });
  });
}

module.exports = {
  getRouters,
  addRouter,
  removeRouter,
};

