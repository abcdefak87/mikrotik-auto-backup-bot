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
      // Reset corrupted data silently
      await saveRouters([]);
      return [];
    }
    return routers;
  } catch (err) {
    // If JSON is corrupted, reset to empty array
    if (err.name === 'SyntaxError' || err.code === 'ENOENT') {
      // Reset corrupted data silently
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
    // Error will be thrown and handled by caller
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
        
        // Write directly instead of calling saveRouters (which would add to queue again)
        // We're already inside the queue, so we can write directly
        await ensureStore();
        const tempPath = `${routersPath}.tmp`;
        await fs.writeJSON(tempPath, routers, { spaces: 2 });
        if (await fs.pathExists(routersPath)) {
          await fs.remove(routersPath);
        }
        await fs.rename(tempPath, routersPath);
        
        resolve(router);
      } catch (err) {
        reject(err);
      }
    }).catch((err) => {
      // Catch any errors from the queue chain
      reject(err);
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
        
        // Use case-insensitive matching with trim (same as addRouter duplicate check)
        const filtered = routers.filter((r) => {
          if (!r.name) return true; // Keep routers without name (shouldn't happen, but safe)
          const routerName = r.name.trim().toLowerCase();
          const targetName = trimmedName.toLowerCase();
          return routerName !== targetName; // Keep routers that don't match
        });
        
        if (filtered.length === routers.length) {
          throw new Error('Router tidak ditemukan');
        }
        
        // Write directly instead of calling saveRouters (which would add to queue again)
        // We're already inside the queue, so we can write directly
        await ensureStore();
        const tempPath = `${routersPath}.tmp`;
        await fs.writeJSON(tempPath, filtered, { spaces: 2 });
        if (await fs.pathExists(routersPath)) {
          await fs.remove(routersPath);
        }
        await fs.rename(tempPath, routersPath);
        resolve();
      } catch (err) {
        reject(err);
      }
    }).catch((err) => {
      // Catch any errors from the queue chain
      reject(err);
    });
  });
}

module.exports = {
  getRouters,
  addRouter,
  removeRouter,
};

