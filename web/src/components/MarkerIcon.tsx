import { ATLASES, type IconEntry } from "@/lib/markerLibrary";

/** Recolorable SVG icon — applies the source as a CSS mask so the visible
 *  color is controlled by the caller (the SVG's own fills are ignored).
 *  Inline-block, no intrinsic margin. */
export function MaskIcon({
  src,
  size,
  color = "currentColor",
  className,
}: {
  src: string;
  size: number;
  color?: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={className}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        backgroundColor: color,
        WebkitMaskImage: `url(${src})`,
        maskImage: `url(${src})`,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
      }}
    />
  );
}

type Props = {
  icon: IconEntry;
  color: string;
  size?: number;
  rotation?: number;
  className?: string;
};

export function MarkerIcon({
  icon,
  color,
  size = 32,
  rotation,
  className,
}: Props) {
  const atlas = ATLASES[icon.atlas];
  const scale = size / icon.w;
  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        backgroundColor: color,
        WebkitMaskImage: `url(${atlas.url})`,
        maskImage: `url(${atlas.url})`,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: `-${icon.x * scale}px -${icon.y * scale}px`,
        maskPosition: `-${icon.x * scale}px -${icon.y * scale}px`,
        WebkitMaskSize: `${atlas.width * scale}px ${atlas.height * scale}px`,
        maskSize: `${atlas.width * scale}px ${atlas.height * scale}px`,
        transform: rotation ? `rotate(${rotation}deg)` : undefined,
        transition: "transform 60ms linear",
      }}
    />
  );
}

function divIconWrapper(
  innerHtml: string,
  label: string,
  size: number,
  selected: boolean,
  interactive: boolean,
  opacity: number,
  labelColor: "black" | "white",
) {
  const safeLabel = label.replace(/[<>&"]/g, "").trim();
  const halo = selected
    ? `<div style="position:absolute;top:-6px;left:-6px;width:${size + 12}px;height:${size + 12}px;border:2px solid #fbbf24;border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,0.4),0 0 12px rgba(251,191,36,0.6);pointer-events:none;"></div>`
    : "";
  const textHex = labelColor === "white" ? "#fff" : "#000";
  const labelHtml = safeLabel
    ? `<div style="position:absolute;top:50%;left:${size + 4}px;transform:translateY(-50%);white-space:nowrap;color:${textHex};font-family:ui-monospace,monospace;font-size:18px;font-weight:600;pointer-events:none;">${safeLabel}</div>`
    : "";
  // When the parent Leaflet Marker is interactive:false, we also need
  // pointer-events:none on the DOM so double-click / line-finish gestures on
  // top of a marker reach the underlying map.
  const pe = interactive ? "cursor:pointer;" : "pointer-events:none;cursor:default;";
  const op = opacity < 1 ? `opacity:${opacity};` : "";
  return `
    <div style="position:relative;transform:translate(-50%,-50%);width:${size}px;height:${size}px;${pe}${op}">
      ${halo}
      ${innerHtml}
      ${labelHtml}
    </div>`;
}

/** Build the inline HTML/CSS used by Leaflet's DivIcon for a custom (atlas) icon. */
export function markerDivIconHtml(
  icon: IconEntry,
  color: string,
  label: string,
  rotation: number,
  size = 36,
  selected = false,
  interactive = true,
  opacity = 1,
  labelColor: "black" | "white" = "black",
) {
  const atlas = ATLASES[icon.atlas];
  const scale = size / icon.w;
  const inner = `
      <div style="
        width:${size}px;
        height:${size}px;
        background-color:${color};
        -webkit-mask-image:url(${atlas.url});
                mask-image:url(${atlas.url});
        -webkit-mask-repeat:no-repeat;
                mask-repeat:no-repeat;
        -webkit-mask-position:-${icon.x * scale}px -${icon.y * scale}px;
                mask-position:-${icon.x * scale}px -${icon.y * scale}px;
        -webkit-mask-size:${atlas.width * scale}px ${atlas.height * scale}px;
                mask-size:${atlas.width * scale}px ${atlas.height * scale}px;
        transform:rotate(${rotation}deg);
        filter:drop-shadow(0 1px 2px rgba(0,0,0,0.7));
      "></div>`;
  return divIconWrapper(inner, label, size, selected, interactive, opacity, labelColor);
}

/** Build the inline HTML/CSS used by Leaflet's DivIcon for a military (PNG) icon. */
export function militaryDivIconHtml(
  iconUrl: string,
  label: string,
  rotation: number,
  size = 36,
  selected = false,
  interactive = true,
  opacity = 1,
  labelColor: "black" | "white" = "black",
) {
  const inner = `
      <img src="${iconUrl}" alt="" width="${size}" height="${size}" style="
        display:block;
        width:${size}px;
        height:${size}px;
        transform:rotate(${rotation}deg);
        filter:drop-shadow(0 1px 2px rgba(0,0,0,0.7));
      " />`;
  return divIconWrapper(inner, label, size, selected, interactive, opacity, labelColor);
}
