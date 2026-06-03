/**
 * Screen Capture — Type Definitions
 */

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureResult {
  file: File;
  name: string;
  thumbnail: string;
  crop_rect: CropRect;
  source_tab_id: number;
  captured_at: string;
}

export interface CaptureOverlayConfig {
  tab_id: number;
  allow_rename: boolean;
  default_name?: string;
}
