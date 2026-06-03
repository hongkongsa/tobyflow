<script lang="ts">
  import { onMount } from 'svelte';
  import { albumsStore } from '../../stores/albums.store';

  let newAlbumName = '';
  let showCreate = false;

  onMount(() => { albumsStore.loadAlbums(); });

  function handleCreate() {
    if (!newAlbumName.trim()) return;
    albumsStore.createAlbum(newAlbumName);
    newAlbumName = '';
    showCreate = false;
  }
</script>

<div class="albums-page">
  {#if $albumsStore.currentAlbum}
    <!-- Photo View -->
    <div class="album-view">
      <div class="album-view-header">
        <button class="back-btn" onclick={() => albumsStore.closeAlbum()}>← Back</button>
        <h2>{$albumsStore.currentAlbum.name}</h2>
        <div class="view-controls">
          <button class="view-btn" class:active={$albumsStore.viewMode === 'grid'} onclick={() => albumsStore.setViewMode('grid')}>▦</button>
          <button class="view-btn" class:active={$albumsStore.viewMode === 'list'} onclick={() => albumsStore.setViewMode('list')}>☰</button>
        </div>
      </div>

      {#if $albumsStore.selectedPhotos.size > 0}
        <div class="selection-bar">
          <span>{$albumsStore.selectedPhotos.size} selected</span>
          <button class="sel-btn" onclick={() => albumsStore.selectAll()}>Select All</button>
          <button class="sel-btn" onclick={() => albumsStore.deselectAll()}>Deselect</button>
          <button class="sel-btn" onclick={() => albumsStore.downloadSelected()}>Download</button>
          <button class="sel-btn danger" onclick={() => albumsStore.deleteSelected()}>Delete</button>
        </div>
      {/if}

      {#if $albumsStore.isLoading}
        <div class="loading">Loading photos...</div>
      {:else if $albumsStore.photos.length === 0}
        <div class="empty-state"><p>No photos in this album</p></div>
      {:else}
        <div class="photo-grid" class:list-mode={$albumsStore.viewMode === 'list'}>
          {#each $albumsStore.photos as photo}
            <div
              class="photo-card"
              class:selected={$albumsStore.selectedPhotos.has(photo.id)}
              onclick={() => albumsStore.togglePhotoSelect(photo.id)}
            >
              <img src={photo.thumbnail || photo.url} alt={photo.prompt} loading="lazy" />
              {#if $albumsStore.selectedPhotos.has(photo.id)}
                <div class="select-overlay">✓</div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <!-- Album List -->
    <div class="album-list-view">
      <div class="albums-header">
        <h2>Albums</h2>
        <button class="new-btn" onclick={() => showCreate = !showCreate}>+ New Album</button>
      </div>

      {#if showCreate}
        <div class="create-form">
          <input class="input-field" placeholder="Album name" bind:value={newAlbumName} />
          <button class="create-btn" onclick={handleCreate}>Create</button>
        </div>
      {/if}

      {#if $albumsStore.isLoading}
        <div class="loading">Loading albums...</div>
      {:else if $albumsStore.albums.length === 0}
        <div class="empty-state">
          <p>No albums yet</p>
          <p class="hint">Albums will store your generated images</p>
        </div>
      {:else}
        <div class="album-grid">
          {#each $albumsStore.albums as album}
            <div class="album-card" onclick={() => albumsStore.openAlbum(album)}>
              <div class="album-thumb">
                {#if album.thumbnail}
                  <img src={album.thumbnail} alt={album.name} />
                {:else}
                  <span class="album-placeholder">🖼️</span>
                {/if}
              </div>
              <div class="album-info">
                <span class="album-name">{album.name}</span>
                <span class="album-count">{album.photo_count} photos</span>
              </div>
              <button class="album-delete" onclick={(e) => { e.stopPropagation(); albumsStore.deleteAlbum(album.id); }}>🗑</button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .albums-page { display: flex; flex-direction: column; gap: 12px; }
  .albums-header, .album-view-header { display: flex; align-items: center; gap: 8px; }
  .albums-header h2, .album-view-header h2 { margin: 0; font-size: 16px; flex: 1; }
  .back-btn { padding: 4px 8px; border: 1px solid var(--border, #2e2e33); border-radius: 4px; background: transparent; color: var(--text-primary, #e4e4e7); font-size: 11px; cursor: pointer; }
  .new-btn { padding: 5px 10px; border: 1px solid var(--accent, #6366f1); border-radius: 5px; background: transparent; color: var(--accent, #6366f1); font-size: 11px; cursor: pointer; }
  .view-controls { display: flex; gap: 2px; }
  .view-btn { width: 24px; height: 24px; border: 1px solid var(--border, #2e2e33); border-radius: 4px; background: transparent; color: var(--text-muted, #71717a); font-size: 12px; cursor: pointer; }
  .view-btn.active { background: var(--accent, #6366f1); color: white; border-color: var(--accent, #6366f1); }
  .selection-bar { display: flex; align-items: center; gap: 6px; padding: 8px; background: var(--bg-secondary, #27272a); border-radius: 6px; font-size: 11px; }
  .sel-btn { padding: 3px 6px; border: 1px solid var(--border, #2e2e33); border-radius: 3px; background: transparent; color: var(--text-primary, #e4e4e7); font-size: 10px; cursor: pointer; }
  .sel-btn.danger { border-color: #dc2626; color: #dc2626; }
  .create-form { display: flex; gap: 6px; }
  .input-field { flex: 1; padding: 7px; border: 1px solid var(--border, #2e2e33); border-radius: 5px; background: var(--bg-secondary, #27272a); color: var(--text-primary, #e4e4e7); font-size: 12px; }
  .create-btn { padding: 7px 12px; border: none; border-radius: 5px; background: var(--accent, #6366f1); color: white; font-size: 12px; cursor: pointer; }
  .loading { text-align: center; color: var(--text-muted, #71717a); padding: 20px; font-size: 12px; }
  .empty-state { text-align: center; padding: 30px; color: var(--text-muted, #71717a); }
  .empty-state p { margin: 4px 0; }
  .hint { font-size: 11px; }
  .album-grid { display: flex; flex-direction: column; gap: 6px; }
  .album-card { display: flex; align-items: center; gap: 10px; padding: 8px; background: var(--bg-secondary, #27272a); border-radius: 8px; cursor: pointer; }
  .album-card:hover { background: var(--bg-tertiary, #3f3f46); }
  .album-thumb { width: 40px; height: 40px; border-radius: 6px; overflow: hidden; background: var(--bg-tertiary, #3f3f46); display: flex; align-items: center; justify-content: center; }
  .album-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .album-placeholder { font-size: 18px; }
  .album-info { flex: 1; display: flex; flex-direction: column; gap: 1px; }
  .album-name { font-size: 12px; font-weight: 500; }
  .album-count { font-size: 10px; color: var(--text-muted, #71717a); }
  .album-delete { width: 24px; height: 24px; border: none; background: transparent; font-size: 12px; cursor: pointer; border-radius: 4px; }
  .album-delete:hover { background: #dc262620; }
  .photo-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
  .photo-grid.list-mode { grid-template-columns: 1fr; }
  .photo-card { position: relative; aspect-ratio: 1; border-radius: 6px; overflow: hidden; cursor: pointer; background: var(--bg-secondary, #27272a); }
  .photo-card img { width: 100%; height: 100%; object-fit: cover; }
  .photo-card.selected { outline: 2px solid var(--accent, #6366f1); }
  .select-overlay { position: absolute; top: 4px; right: 4px; width: 18px; height: 18px; border-radius: 50%; background: var(--accent, #6366f1); color: white; font-size: 10px; display: flex; align-items: center; justify-content: center; }
</style>
