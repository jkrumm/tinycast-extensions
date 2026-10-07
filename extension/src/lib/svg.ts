// Public entry of the SVG chart library for Tinycast hero/tile images. The
// implementation lives in `lib/chart/` (core: theme + plumbing, series: area /
// line / sparkline, bars: bar charts + threshold bar, gauges: rings, glyphs,
// tile); import from here. Reference: `.claude/skills/svg-charts/SKILL.md`.

export {
  HERO_COL_WIDTH,
  RAYCAST_COLOR,
  THEME,
  assertLegible,
  clamp,
  computeImageScale,
  escapeXml,
  formatNumber,
  svgDocument,
  thresholdColor,
  toDataUri,
} from "./chart/core";
export type { RaycastColor, Size } from "./chart/core";

export { areaChart, lineChart, sparkline } from "./chart/series";
export type {
  ChartMark,
  ReferenceLine,
  SparklineSpec,
  TimeChartSpec,
  TimeSeries,
} from "./chart/series";

export { barChart, thresholdBar } from "./chart/bars";
export type {
  BarChartSpec,
  BarItem,
  BarSegment,
  ThresholdBarSpec,
} from "./chart/bars";

export { statCards, statusPanel } from "./chart/cards";
export type {
  PanelColumn,
  StatCard,
  StatCardsSpec,
  StatusPanelSpec,
  StatDelta,
  StatTone,
} from "./chart/cards";

export {
  batteryGlyph,
  heroColumns,
  heroRows,
  menuBarRing,
  ring,
  ringGaugeRow,
  signalBars,
  tile,
} from "./chart/gauges";
export type {
  BatteryGlyphSpec,
  MenuBarRingSpec,
  RingGaugeSpec,
  SignalBarsSpec,
  TileSpec,
} from "./chart/gauges";
