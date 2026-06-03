/**
 * Albums Store — manages photo albums
 */
import { writable, derived } from 'svelte/store';

export interface Album {
  id: string;
  name: string;
  photo_count: number;
  thumbnail?: string;
  created_at: string;
}

export interface Photo {
  id: string;
  url: string;
  thumbnail: string;
  prompt: string;
  provider: string;
  created_at: string;
}

export interface AlbumsState {
  albums: Album[];
  currentAlbum: Album | null;
  photos: Photo[];
  selectedPhotos: Set<string>;
  isLoading: boolean;
  viewMode: 'grid' | 'list';
}

const DEFAULT_STATE: AlbumsState = {
  albums: [],
  currentAlbum: null,
  photos: [],
  selectedPhotos: new Set(),
  isLoading: false,
  viewMode: 'grid',
};

function createAlbumsStore() {
  const { subscribe, update } = writable<AlbumsState>({ ...DEFAULT_STATE });

  return {
    subscribe,

    async loadAlbums() {
      update(s => ({ ...s, isLoading: true }));
      try {
        const response = await chrome.runtime.sendMessage({ type: 'ALBUMS_LIST' });
        if (response.success) {
          update(s => ({ ...s, albums: response.albums || [], isLoading: false }));
        } else {
          update(s => ({ ...s, isLoading: false }));
        }
      } catch {
        update(s => ({ ...s, isLoading: false }));
      }
    },

    async openAlbum(album: Album) {
      update(s => ({ ...s, currentAlbum: album, isLoading: true, photos: [], selectedPhotos: new Set() }));
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'ALBUMS_PHOTOS',
          payload: { albumId: album.id },
        });
        if (response.success) {
          update(s => ({ ...s, photos: response.photos || [], isLoading: false }));
        } else {
          update(s => ({ ...s, isLoading: false }));
        }
      } catch {
        update(s => ({ ...s, isLoading: false }));
      }
    },

    closeAlbum() {
      update(s => ({ ...s, currentAlbum: null, photos: [], selectedPhotos: new Set() }));
    },

    async createAlbum(name: string) {
      const response = await chrome.runtime.sendMessage({
        type: 'ALBUMS_CREATE',
        payload: { name },
      });
      if (response.success && response.album) {
        update(s => ({ ...s, albums: [...s.albums, response.album] }));
      }
    },

    async deleteAlbum(albumId: string) {
      await chrome.runtime.sendMessage({ type: 'ALBUMS_DELETE', payload: { albumId } });
      update(s => ({ ...s, albums: s.albums.filter(a => a.id !== albumId) }));
    },

    togglePhotoSelect(photoId: string) {
      update(s => {
        const sel = new Set(s.selectedPhotos);
        if (sel.has(photoId)) sel.delete(photoId);
        else sel.add(photoId);
        return { ...s, selectedPhotos: sel };
      });
    },

    selectAll() {
      update(s => ({ ...s, selectedPhotos: new Set(s.photos.map(p => p.id)) }));
    },

    deselectAll() {
      update(s => ({ ...s, selectedPhotos: new Set() }));
    },

    async downloadSelected() {
      let state: AlbumsState | undefined;
      const unsub = subscribe(s => { state = s; });
      unsub();
      if (!state) return;
      await chrome.runtime.sendMessage({
        type: 'PHOTOS_DOWNLOAD',
        payload: { photoIds: [...state.selectedPhotos] },
      });
    },

    async deleteSelected() {
      let state: AlbumsState | undefined;
      const unsub = subscribe(s => { state = s; });
      unsub();
      if (!state) return;
      const ids = [...state.selectedPhotos];
      await chrome.runtime.sendMessage({
        type: 'PHOTOS_DELETE',
        payload: { photoIds: ids },
      });
      update(s => ({
        ...s,
        photos: s.photos.filter(p => !ids.includes(p.id)),
        selectedPhotos: new Set(),
      }));
    },

    setViewMode(mode: 'grid' | 'list') {
      update(s => ({ ...s, viewMode: mode }));
    },
  };
}

export const albumsStore = createAlbumsStore();
export const albumsList = derived(albumsStore, $s => $s.albums);
