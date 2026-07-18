"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseMarkersLayer,
  type ImportResult,
} from "@/lib/layerImport";
import { MAPS } from "@/lib/maps";
import { useT } from "@/components/LanguageProvider";

type Stage =
  | { kind: "idle" }
  | { kind: "parsing" }
  | { kind: "parsed"; result: ImportResult }
  | { kind: "error"; message: string };

export function ImportDialog({
  onClose,
  onCommit,
}: {
  onClose: () => void;
  /** Caller receives the parsed result and the map key the commander picked.
   *  If that map differs from the current selection, caller should switch. */
  onCommit: (result: ImportResult, mapKey: string) => void;
}) {
  const { t, tp } = useT();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [dragOver, setDragOver] = useState(false);
  const [pickedMapKey, setPickedMapKey] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const parseText = useCallback((text: string) => {
    setStage({ kind: "parsing" });
    try {
      const result = parseMarkersLayer(text);
      setStage({ kind: "parsed", result });
    } catch (e) {
      setStage({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  const handleFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result ?? "");
        parseText(text);
      };
      reader.onerror = () => {
        setStage({ kind: "error", message: t("import.readError") });
      };
      reader.readAsText(file);
    },
    [parseText, t],
  );

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  const parsedCounts = (() => {
    if (stage.kind !== "parsed") return null;
    let custom = 0;
    let military = 0;
    for (const m of stage.result.markers) {
      if (m.kind === "custom") custom++;
      else military++;
    }
    const polygons = stage.result.polygons.length;
    return {
      custom,
      military,
      polygons,
      total: custom + military + polygons,
    };
  })();

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[1800] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-w-[92vw] bg-[#202427] rounded-[12px] shadow-[0px_16px_32px_0px_rgba(0,0,0,0.5)] p-6 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-slab text-[20px] leading-[24px] text-white font-medium">
            {t("import.title")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-white/60 hover:text-white text-[14px] leading-[20px]"
            aria-label={t("action.close")}
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-[12px] leading-[16px] text-white/60">
            {t("field.map")} <span className="text-[#f26f63]">*</span>{" "}
            <span className="text-white/40">{t("import.map.hint")}</span>
          </label>
          <div className="relative bg-[#14181a] border border-[#2e3439] rounded-[4px] h-[40px] flex items-center p-3">
            <span
              className={`flex-1 truncate text-[14px] leading-[20px] ${
                pickedMapKey ? "text-white" : "text-white/40"
              }`}
            >
              {pickedMapKey
                ? (MAPS.find((m) => m.key === pickedMapKey)?.label ??
                  pickedMapKey)
                : t("placeholder.selectMap")}
            </span>
            <svg
              aria-hidden
              width={10}
              height={6}
              viewBox="0 0 10 6"
              className="shrink-0 text-white/60"
            >
              <path d="M0 0l5 6 5-6H0z" fill="currentColor" />
            </svg>
            <select
              aria-label={t("field.map")}
              value={pickedMapKey}
              onChange={(e) => setPickedMapKey(e.target.value)}
              className="absolute inset-0 opacity-0 cursor-pointer"
            >
              <option value="" disabled>
                {t("placeholder.selectMap")}
              </option>
              {MAPS.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {(stage.kind === "idle" || stage.kind === "parsing") && (
          <>
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={`rounded-[8px] border-2 border-dashed p-6 flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors ${
                dragOver
                  ? "border-[#f4db50] bg-[#f4db50]/5"
                  : "border-[#2e3439] bg-[#14181a] hover:bg-[#1a1e21]"
              }`}
            >
              <div className="text-[14px] leading-[20px] text-white">
                {t("import.dropzone.before")}{" "}
                <code className="text-[#f4db50]">.layer</code>
                {t("import.dropzone.after") && (
                  <> {t("import.dropzone.after")}</>
                )}
              </div>
              <div className="text-[12px] leading-[16px] text-white/40">
                {t("import.dropzone.hint")}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".layer,text/plain"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  e.target.value = "";
                }}
              />
            </label>
            {stage.kind === "parsing" && (
              <div className="text-[12px] leading-[16px] text-white/60">
                {t("import.parsing")}
              </div>
            )}
          </>
        )}

        {stage.kind === "error" && (
          <div className="rounded-[4px] bg-[#f26f63]/10 border border-[#f26f63]/40 p-3">
            <div className="text-[14px] leading-[20px] text-[#f26f63] font-medium">
              {t("import.failed")}
            </div>
            <div className="text-[12px] leading-[16px] text-white/60 mt-1">
              {stage.message}
            </div>
          </div>
        )}

        {stage.kind === "parsed" && parsedCounts && (
          <div className="flex flex-col gap-3">
            <div className="rounded-[4px] bg-[#14181a] border border-[#2e3439] p-3 flex flex-col gap-1">
              <div className="text-[14px] leading-[20px] text-white">
                {t("import.found.before")}{" "}
                <span className="text-[#f4db50]">{parsedCounts.total}</span>{" "}
                {t("import.found.after", {
                  w: tp("count.item", parsedCounts.total),
                })}
              </div>
              <div className="text-[12px] leading-[16px] text-white/60">
                {t("import.breakdown", {
                  custom: parsedCounts.custom,
                  military: parsedCounts.military,
                  polygons: parsedCounts.polygons,
                  w: tp("count.polygon", parsedCounts.polygons),
                })}
              </div>
            </div>

            {stage.result.warnings.length > 0 && (
              <div className="rounded-[4px] bg-[#f4db50]/10 border border-[#f4db50]/30 p-3 flex flex-col gap-1 max-h-[160px] overflow-y-auto">
                <div className="text-[12px] leading-[16px] text-[#f4db50] font-medium">
                  {t("import.warnings.count", {
                    n: stage.result.warnings.length,
                    w: tp("count.warning", stage.result.warnings.length),
                  })}
                </div>
                {stage.result.warnings.slice(0, 20).map((w, i) => (
                  <div key={i} className="text-[11px] leading-[14px] text-white/70">
                    {w}
                  </div>
                ))}
                {stage.result.warnings.length > 20 && (
                  <div className="text-[11px] leading-[14px] text-white/40">
                    {t("import.warnings.more", {
                      n: stage.result.warnings.length - 20,
                    })}
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setStage({ kind: "idle" })}
                className="px-3 py-2 text-[14px] leading-[20px] text-white/70 hover:text-white"
              >
                {t("import.pickAnother")}
              </button>
              <button
                type="button"
                onClick={() => {
                  onCommit(stage.result, pickedMapKey);
                  onClose();
                }}
                disabled={parsedCounts.total === 0 || !pickedMapKey}
                className="px-4 py-2 rounded-[4px] bg-[#f4db50] text-[#202427] text-[14px] leading-[20px] font-medium hover:bg-[#f4db50]/90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {t("import.merge")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
