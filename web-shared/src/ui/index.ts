// Marketly UI components. Each maps 1:1 to a helper in the design prototype (design/README.md,
// "Component inventory") and renders the design's markup and classes from src/styles/marketly.css.
export { Icon, LogoMark, iconFor, type IconName } from './Icon';
export { Button, IconButton, CopyButton, type ButtonVariant } from './Button';
export { Badge, StatusBadge, Sponsored, Count, statusTone, STATUS_TONE, type Tone } from './Badge';
export { Img, Avatar, LogoTile, sameOriginFile, tintClass, type Tint } from './Media';
export { Price, Stars, Stars5, SellerBadge, SellerLine, ShipLine, ProductCard, QuantityStepper, Countdown, Meter, type CardProduct } from './Commerce';
export {
  Card, Breadcrumbs, PageHeader, SectionHeader, Tabs, SegmentedControl, Chip, ChipRow, Steps, Track, Timeline,
  KeyValue, SummaryRow, Stat, Alert, EmptyState, Deadline, LazyLoad, Pager, TableWrap, StatusLegend,
  SearchInput, PhoneCollapse, type Crumb, type TabItem, type TimelineEvent,
} from './Structure';
export { Field, TextInput, Select, Textarea, Checkbox, Radio, Switch, OptionCard, FileDrop } from './Forms';
export { PhoneInput } from './PhoneInput';
export { Dialog, Drawer } from './Overlays';
export { ImageCropper, type CropWording, type ProcessedImage } from './ImageCropper';
export { DateTimeField } from './DateTimeField';
export { RichText, InlineHtml, DataTable, htmlToText, PlainLink, type ContentLink } from './RichText';
export { LoadError, SkeletonLines, isForbidden } from './Loading';
// Charts (docs/09 §4.1): Recharts styled with the chart tokens; one file per component under ./charts.
export { TrendChart, type TrendChartProps } from './charts/TrendChart';
export { BarsChart, type BarsChartProps } from './charts/BarsChart';
export { ComboChart, type ComboChartProps } from './charts/ComboChart';
export { WaterfallChart, toWaterfall, waterfallTable, type WaterfallStepInput, type WaterfallBar } from './charts/WaterfallChart';
export { DonutChart, foldSlices, donutTable, type DonutSlice } from './charts/DonutChart';
export { ShareBar, type SharePart } from './charts/ShareBar';
export { ChartFrame, DataTableView, seriesTable, type ChartFrameProps, type ChartTable, type ChartTableColumn } from './charts/ChartFrame';
export { ChartLegend, useHiddenSeries, type LegendItem } from './charts/ChartLegend';
export { ChartTooltip, type TooltipLine } from './charts/ChartTooltip';
export { seriesFromReport, rowsFrom, type ReportChartData, type ReportSeriesPick, type ReportLike } from './charts/seriesFromReport';
export {
  chartColor, seriesColor, compareKey, valueOf, hasCompare, changeText, fmtForUnit, fmtMoney, fmtMoneyCompact, fmtCount, fmtCountCompact, fmtPercent, fmtPercentCompact,
  MAX_SERIES, COMPARE_COLOR, POSITIVE_COLOR, NEGATIVE_COLOR, type ChartRow, type ChartSeries, type Fmt,
} from './charts/model';
export { PeriodControl, usePeriod, type PeriodControlProps, type Period, type PeriodCompare, type PeriodGrain, type PeriodPreset, type PeriodQuery } from './PeriodControl';
export { announce } from './announce';
export { ToastStack, addToast, MAX_TOASTS, type ToastItem } from './ToastStack';
