---
name: indexeddb-spa
description: IndexedDB client-side storage with SPA patterns for offline-first applications. Use when implementing browser storage, client-side databases, or sync between local and server data.
---

# IndexedDB SPA Skill

Client-side storage and SPA data management.

## Quick Reference

### Basic Operations (using idb wrapper)

```javascript
import { openDB } from 'idb';

// Open database
const db = await openDB('myapp', 1, {
  upgrade(db) {
    db.createObjectStore('items', { keyPath: 'id' });
  }
});

// CRUD operations
await db.put('items', { id: 1, name: 'Item 1' });
const item = await db.get('items', 1);
const all = await db.getAll('items');
await db.delete('items', 1);
```

### Database Schema

```javascript
const db = await openDB('myapp', 2, {
  upgrade(db, oldVersion, newVersion, transaction) {
    // Version 1: Create stores
    if (oldVersion < 1) {
      const itemStore = db.createObjectStore('items', { keyPath: 'id' });
      itemStore.createIndex('by-date', 'createdAt');
      itemStore.createIndex('by-category', 'category');
    }
    
    // Version 2: Add new store
    if (oldVersion < 2) {
      db.createObjectStore('settings', { keyPath: 'key' });
    }
  }
});
```

### Indexes & Queries

```javascript
// Create index
store.createIndex('by-category', 'category');

// Query by index
const tx = db.transaction('items', 'readonly');
const index = tx.store.index('by-category');
const items = await index.getAll('books');

// Range queries
const range = IDBKeyRange.bound('a', 'z');
const items = await index.getAll(range);

// Cursor iteration
let cursor = await index.openCursor();
while (cursor) {
  console.log(cursor.value);
  cursor = await cursor.continue();
}
```

## SPA Storage Patterns

### Local-First Architecture

```javascript
class DataStore {
  constructor() {
    this.db = null;
    this.syncQueue = [];
  }
  
  async init() {
    this.db = await openDB('app', 1, {
      upgrade(db) {
        db.createObjectStore('projects', { keyPath: 'id' });
        db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
      }
    });
  }
  
  // Always write locally first
  async save(project) {
    project.updatedAt = Date.now();
    project.synced = false;
    await this.db.put('projects', project);
    await this.queueSync('update', project);
    return project;
  }
  
  async queueSync(action, data) {
    await this.db.put('syncQueue', { action, data, timestamp: Date.now() });
    this.processQueue(); // Try to sync
  }
  
  async processQueue() {
    if (!navigator.onLine) return;
    
    const queue = await this.db.getAll('syncQueue');
    for (const item of queue) {
      try {
        await this.syncToServer(item);
        await this.db.delete('syncQueue', item.id);
      } catch (e) {
        console.error('Sync failed:', e);
        break; // Stop on first failure
      }
    }
  }
}
```

### Server Sync Strategy

```javascript
class SyncManager {
  // Pull from server
  async pullFromServer() {
    const serverData = await fetch('/api/projects').then(r => r.json());
    const localData = await this.db.getAll('projects');
    
    for (const serverItem of serverData) {
      const local = localData.find(l => l.id === serverItem.id);
      
      if (!local) {
        // New from server
        await this.db.put('projects', { ...serverItem, synced: true });
      } else if (serverItem.updatedAt > local.updatedAt && local.synced) {
        // Server is newer and local hasn't changed
        await this.db.put('projects', { ...serverItem, synced: true });
      }
      // If local.synced === false, local changes take priority
    }
  }
  
  // Push to server
  async pushToServer() {
    const unsynced = await this.db.getAll('projects');
    const toSync = unsynced.filter(p => !p.synced);
    
    for (const project of toSync) {
      await fetch('/api/projects/' + project.id, {
        method: 'PUT',
        body: JSON.stringify(project),
        headers: { 'Content-Type': 'application/json' }
      });
      project.synced = true;
      await this.db.put('projects', project);
    }
  }
}
```

### Dual Storage (Local + Server Projects)

```javascript
// Separate stores for different data sources
const db = await openDB('app', 1, {
  upgrade(db) {
    // Local-only projects (privacy-first)
    db.createObjectStore('localProjects', { keyPath: 'id' });
    
    // Server-synced projects
    db.createObjectStore('serverProjects', { keyPath: 'id' });
    
    // Metadata
    db.createObjectStore('meta', { keyPath: 'key' });
  }
});

// Query both
async function getAllProjects() {
  const local = await db.getAll('localProjects');
  const server = await db.getAll('serverProjects');
  return [...local, ...server].sort((a, b) => b.updatedAt - a.updatedAt);
}
```

## SPA Navigation Patterns

### Persistent Player State

```javascript
class PlayerState {
  constructor() {
    this.db = null;
    this.currentQueue = [];
    this.currentIndex = 0;
  }
  
  async init() {
    this.db = await openDB('player', 1, {
      upgrade(db) {
        db.createObjectStore('state', { keyPath: 'key' });
      }
    });
    await this.restore();
  }
  
  async save() {
    await this.db.put('state', {
      key: 'playerState',
      queue: this.currentQueue,
      index: this.currentIndex,
      timestamp: Date.now()
    });
  }
  
  async restore() {
    const state = await this.db.get('state', 'playerState');
    if (state) {
      this.currentQueue = state.queue;
      this.currentIndex = state.index;
    }
  }
}

// Save on navigation (SPA)
window.addEventListener('beforeunload', () => player.save());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) player.save();
});
```

### SPA Router with State Preservation

```javascript
class SPARouter {
  constructor() {
    this.preservedElements = ['#player', '#footer-panel'];
  }
  
  async navigate(url) {
    // Save current state
    await this.saveState();
    
    // Fetch new content
    const html = await fetch(url).then(r => r.text());
    
    // Parse and replace only content area
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    const newContent = doc.querySelector('#content');
    document.querySelector('#content').replaceWith(newContent);
    
    // Update URL
    history.pushState({}, '', url);
    
    // Preserved elements remain untouched
  }
  
  async saveState() {
    const state = {
      scroll: window.scrollY,
      // ... other state
    };
    sessionStorage.setItem('pageState', JSON.stringify(state));
  }
}
```

## Error Handling

```javascript
async function safeDBOperation(operation) {
  try {
    return await operation();
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      // Storage full - clean up old data
      await cleanupOldData();
      return await operation();
    }
    if (e.name === 'InvalidStateError') {
      // Database closed - reopen
      await this.init();
      return await operation();
    }
    throw e;
  }
}

async function cleanupOldData() {
  const db = await openDB('app', 1);
  const tx = db.transaction('cache', 'readwrite');
  
  // Delete items older than 7 days
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let cursor = await tx.store.openCursor();
  
  while (cursor) {
    if (cursor.value.timestamp < cutoff) {
      await cursor.delete();
    }
    cursor = await cursor.continue();
  }
}
```

## Debugging

```javascript
// List all databases
const dbs = await indexedDB.databases();
console.log(dbs);

// Export database
async function exportDB() {
  const db = await openDB('app', 1);
  const data = {};
  for (const name of db.objectStoreNames) {
    data[name] = await db.getAll(name);
  }
  return JSON.stringify(data, null, 2);
}

// Clear database
async function clearDB() {
  const db = await openDB('app', 1);
  for (const name of db.objectStoreNames) {
    await db.clear(name);
  }
}

// Delete database entirely
indexedDB.deleteDatabase('app');
```
