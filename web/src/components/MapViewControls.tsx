"use client";

import { useT } from "@/components/LanguageProvider";

// Top-right map HUD cluster shared by the 2D and 3D views: zoom in/out,
// fit whole map, and the 2D/3D view toggle (ported from ts-mission-builder).
// Desktop only — mobile pinch-zooms and stays 2D.
type Props = {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  view3D: boolean;
  onToggleView: () => void;
};

const BTN =
  "w-9 h-9 bg-[#202427] hover:bg-[#2e3439] active:bg-[#3a4249] flex items-center justify-center";

export default function MapViewControls({ onZoomIn, onZoomOut, onFit, view3D, onToggleView }: Props) {
  const { t } = useT();
  return (
    <div className="max-md:hidden absolute top-4 right-4 z-[1000] flex flex-col gap-px rounded-[8px] overflow-hidden shadow-[0px_16px_32px_0px_rgba(0,0,0,0.4)]">
      <button
        type="button"
        aria-label={t("view.zoomIn")}
        title={t("view.zoomIn")}
        onClick={onZoomIn}
        className={`${BTN} text-white text-[18px] font-medium`}
      >
        +
      </button>
      <button
        type="button"
        aria-label={t("view.zoomOut")}
        title={t("view.zoomOut")}
        onClick={onZoomOut}
        className={`${BTN} text-white text-[18px] font-medium`}
      >
        −
      </button>
      <button
        type="button"
        aria-label={t("view.fit")}
        title={t("view.fit")}
        onClick={onFit}
        className={`${BTN} text-white/70`}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
          <path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={t(view3D ? "view.2d" : "view.3d")}
        title={t(view3D ? "view.2d" : "view.3d")}
        onClick={onToggleView}
        className={`${BTN} text-[11px] font-semibold ${view3D ? "text-[#f4db50]" : "text-white/70"}`}
      >
        3D
      </button>
    </div>
  );
}
