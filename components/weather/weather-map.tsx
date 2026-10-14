"use client";

import bbox from "@turf/bbox";
import type { Feature, FeatureCollection } from "geojson";
import maplibregl, { type ExpressionSpecification, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { formatAlertDistance, formatPointDistance } from "@/lib/weather/format";
import { radiusCircle } from "@/lib/weather/geography";
import { SEVERITY_LABELS, severityRank } from "@/lib/weather/severity";
import type { DetectedWeatherRisk, SeverityLevel, WeatherAlert } from "@/lib/weather/types";
import type { MapPopupContent, MapSelection } from "@/lib/weather/view-model";
import { DEFAULT_VIEW, MAP_COLORS, MAP_STYLE_URL } from "./map-theme";

export type MapCenter = { latitude: number; longitude: number; label: string };

type Props = {
  center: MapCenter | null;
  radiusMiles: number;
  alerts: WeatherAlert[];
  risks: DetectedWeatherRisk[];
  selection: MapSelection | null;
  onSelect: (id: string) => void;
  /** Changes whenever a new check completes, to bring the whole radius back into view. */
  viewKey: string;
};

const SOURCE = { radius: "wm-radius", alerts: "wm-alerts" } as const;
const LAYER = {
  radiusFill: "wm-radius-fill",
  radiusLine: "wm-radius-line",
  alertFill: "wm-alert-fill",
  alertLine: "wm-alert-line",
  alertSelected: "wm-alert-selected",
} as const;

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const LOAD_TIMEOUT_MS = 15_000;

const selectedFilter = (id: string): ExpressionSpecification => ["==", ["get", "id"], id];
const fillOpacity = (id: string): ExpressionSpecification => ["case", ["==", ["get", "id"], id], 0.34, 0.14];

function addOverlayLayers(map: maplibregl.Map) {
  // Keep the basemap's place names readable by drawing underneath its first label layer.
  const firstLabel = map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;

  map.addSource(SOURCE.radius, { type: "geojson", data: EMPTY });
  map.addSource(SOURCE.alerts, { type: "geojson", data: EMPTY });

  map.addLayer(
    {
      id: LAYER.radiusFill,
      type: "fill",
      source: SOURCE.radius,
      paint: { "fill-color": MAP_COLORS.accent, "fill-opacity": 0.05 },
    },
    firstLabel,
  );
  map.addLayer(
    {
      id: LAYER.alertFill,
      type: "fill",
      source: SOURCE.alerts,
      paint: { "fill-color": ["get", "color"], "fill-opacity": fillOpacity("") },
    },
    firstLabel,
  );
  map.addLayer(
    {
      id: LAYER.alertLine,
      type: "line",
      source: SOURCE.alerts,
      paint: { "line-color": ["get", "color"], "line-width": 1.25, "line-opacity": 0.9 },
    },
    firstLabel,
  );
  map.addLayer(
    {
      id: LAYER.alertSelected,
      type: "line",
      source: SOURCE.alerts,
      filter: selectedFilter(""),
      paint: { "line-color": ["get", "color"], "line-width": 3 },
    },
    firstLabel,
  );
  map.addLayer(
    {
      id: LAYER.radiusLine,
      type: "line",
      source: SOURCE.radius,
      paint: { "line-color": MAP_COLORS.accent, "line-width": 1.5, "line-opacity": 0.8 },
    },
    firstLabel,
  );
}

function createMarkerElement(kind: "alert" | "detected", level: SeverityLevel, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "wm-marker";
  button.dataset.kind = kind;
  button.dataset.level = level;
  button.setAttribute("aria-label", label);
  const shape = document.createElement("span");
  shape.className = "wm-marker__shape";
  if (kind === "alert") shape.textContent = "!";
  button.append(shape);
  return button;
}

/** Built with DOM nodes and textContent so alert text can never inject markup. */
function createPopupNode(content: MapPopupContent): HTMLElement {
  const root = document.createElement("div");
  const add = (className: string, text: string) => {
    const paragraph = document.createElement("p");
    paragraph.className = className;
    paragraph.textContent = text;
    root.append(paragraph);
  };
  add("wm-popup__kind", `${content.kind}, ${SEVERITY_LABELS[content.level].toLowerCase()} severity`);
  add("wm-popup__title", content.title);
  for (const line of content.lines) add("wm-popup__line", line);
  return root;
}

const animationDuration = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 600;

function LegendItem({ shape, label }: { shape: string; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <span aria-hidden className={shape} />
      {label}
    </li>
  );
}

export function WeatherMap({ center, radiusMiles, alerts, risks, selection, onSelect, viewKey }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef(new Map<string, maplibregl.Marker>());
  const centerMarkerRef = useRef<maplibregl.Marker | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const onSelectRef = useRef(onSelect);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // Create the map once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container,
        style: MAP_STYLE_URL,
        center: DEFAULT_VIEW.center,
        zoom: DEFAULT_VIEW.zoom,
        attributionControl: { compact: true },
      });
    } catch {
      // WebGL unavailable. The results list still works without the map.
      const failTimer = setTimeout(() => setStatus("failed"), 0);
      return () => clearTimeout(failTimer);
    }
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    const loadTimer = setTimeout(() => setStatus((current) => (current === "loading" ? "failed" : current)), LOAD_TIMEOUT_MS);

    map.on("load", () => {
      clearTimeout(loadTimer);
      addOverlayLayers(map);
      map.on("click", LAYER.alertFill, (event) => {
        const id = event.features?.[0]?.properties?.id;
        if (typeof id === "string") onSelectRef.current(id);
      });
      map.on("mouseenter", LAYER.alertFill, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", LAYER.alertFill, () => (map.getCanvas().style.cursor = ""));
      setStatus("ready");
    });

    return () => {
      clearTimeout(loadTimer);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const latitude = center?.latitude ?? null;
  const longitude = center?.longitude ?? null;
  const centerLabel = center?.label ?? "";

  // Center point and radius circle. The circle is real geography, not a CSS shape.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const source = map.getSource<GeoJSONSource>(SOURCE.radius);

    centerMarkerRef.current?.remove();
    centerMarkerRef.current = null;
    if (latitude === null || longitude === null) {
      source?.setData(EMPTY);
      return;
    }

    const circle = radiusCircle({ latitude, longitude }, radiusMiles);
    source?.setData(circle);

    const element = document.createElement("div");
    element.className = "wm-center";
    element.setAttribute("role", "img");
    element.setAttribute("aria-label", `Center: ${centerLabel}`);
    element.title = centerLabel;
    centerMarkerRef.current = new maplibregl.Marker({ element }).setLngLat([longitude, latitude]).addTo(map);

    const [west, south, east, north] = bbox(circle);
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: 32, duration: animationDuration() },
    );
  }, [status, latitude, longitude, centerLabel, radiusMiles, viewKey]);

  // Alert areas (polygons) plus a marker for every alert and every detected risk.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    const features: Feature[] = [...alerts]
      // Later features draw on top: most severe last.
      .sort((a, b) => severityRank(a.level) - severityRank(b.level))
      .flatMap((alert) =>
        alert.geometry
          ? [
              {
                type: "Feature" as const,
                geometry: alert.geometry,
                properties: { id: alert.id, color: MAP_COLORS.severity[alert.level] },
              },
            ]
          : [],
      );
    map.getSource<GeoJSONSource>(SOURCE.alerts)?.setData({ type: "FeatureCollection", features });

    const markers = new Map<string, maplibregl.Marker>();
    const addMarker = (id: string, element: HTMLButtonElement, lngLat: [number, number]) => {
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        onSelectRef.current(id);
      });
      markers.set(id, new maplibregl.Marker({ element }).setLngLat(lngLat).addTo(map));
    };

    for (const risk of risks) {
      const label = `${risk.title}, ${SEVERITY_LABELS[risk.severity].toLowerCase()} severity. ${risk.locationLabel ?? ""} ${formatPointDistance(risk.distanceMiles)}. Show details.`;
      addMarker(risk.id, createMarkerElement("detected", risk.severity, label), [risk.longitude, risk.latitude]);
    }
    for (const alert of alerts) {
      if (!alert.anchor) continue;
      const label = `${alert.event}, ${SEVERITY_LABELS[alert.level].toLowerCase()} severity. ${formatAlertDistance(alert.distanceMiles) ?? ""}. Show details.`;
      addMarker(alert.id, createMarkerElement("alert", alert.level, label), alert.anchor);
    }
    markersRef.current = markers;

    return () => {
      markers.forEach((marker) => marker.remove());
      markersRef.current = new Map();
    };
  }, [status, alerts, risks]);

  // Selection: highlight, optionally move the camera, open the popup.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    const selectedId = selection?.id ?? "";
    map.setFilter(LAYER.alertSelected, selectedFilter(selectedId));
    map.setPaintProperty(LAYER.alertFill, "fill-opacity", fillOpacity(selectedId));
    markersRef.current.forEach((marker, id) => {
      marker.getElement().dataset.selected = String(id === selectedId);
    });

    popupRef.current?.remove();
    popupRef.current = null;
    if (!selection) return;

    if (selection.moveCamera) {
      const duration = animationDuration();
      if (selection.fit) {
        const [west, south, east, north] = selection.fit;
        map.fitBounds(
          [
            [west, south],
            [east, north],
          ],
          { padding: 72, maxZoom: 10, duration },
        );
      } else if (selection.anchor) {
        map.easeTo({ center: selection.anchor, zoom: Math.max(map.getZoom(), 8), duration });
      }
    }

    if (selection.anchor) {
      popupRef.current = new maplibregl.Popup({ offset: 16, maxWidth: "280px", focusAfterOpen: false })
        .setLngLat(selection.anchor)
        .setDOMContent(createPopupNode(selection.popup))
        .addTo(map);
    }
  }, [status, selection, alerts, risks]);

  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-surface">
      <div
        ref={containerRef}
        role="region"
        aria-label={
          center
            ? `Map of weather risks within ${radiusMiles} miles of ${center.label}`
            : "Map of weather risks"
        }
        className="h-[360px] w-full sm:h-[460px]"
      />

      {status === "loading" && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-canvas text-sm text-ink-muted">
          Loading map…
        </div>
      )}

      {status === "failed" && (
        <div role="alert" className="absolute inset-0 grid place-items-center bg-canvas p-6 text-center">
          <div className="max-w-sm">
            <p className="text-sm font-semibold text-ink">The map could not load</p>
            <p className="mt-1 text-sm text-ink-muted">
              Weather results are still listed below. Check your connection and reload the page to bring the map back.
            </p>
          </div>
        </div>
      )}

      {status === "ready" && (
        <ul className="absolute bottom-2 left-2 flex flex-wrap gap-x-3 gap-y-1 rounded-lg border border-line bg-surface/95 px-2.5 py-1.5 text-xs text-ink-muted">
          <LegendItem shape="size-2.5 rounded-full bg-accent ring-2 ring-white" label="ZIP center" />
          <LegendItem shape="size-3 rounded-full border-[1.5px] border-accent bg-accent/10" label="Radius" />
          <LegendItem shape="size-3 rounded-[3px] bg-ink-muted" label="Official alert" />
          <LegendItem shape="size-2.5 rounded-full bg-ink-muted" label="Detected risk" />
        </ul>
      )}
    </div>
  );
}
