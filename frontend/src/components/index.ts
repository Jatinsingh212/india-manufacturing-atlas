/**
 * Component barrel for page builders: `import { Card, DataTable, KpiTile } from '@/components';`
 *
 * Heavy pieces (EChart -> echarts, NetworkGraph -> cytoscape, Markdown -> react-markdown) load their
 * libraries lazily, so importing from this barrel stays cheap. Shell code (layout, auth) imports the
 * individual files instead.
 */
export { AnimatedValue } from './AnimatedValue';
export { Badge, type BadgeProps, type BadgeTone } from './Badge';
export { Insight, type InsightPoint, type InsightProps, type InsightTone } from './Insight';
export { Term, type TermProps } from './Term';
export { Button, IconButton, buttonClass, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button';
export { Card, SectionLabel, type CardProps } from './Card';
export { CountryBars, type CountryBarsProps } from './CountryBars';
export { DataTable, type Column, type DataTablePagination, type DataTableProps, type SortState } from './DataTable';
export { DownloadMenu, type DownloadMenuProps } from './DownloadMenu';
export { EChart, type EChartEventHandler, type EChartProps } from './EChart';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { ErrorState, type ErrorStateProps } from './ErrorState';
export {
  FormField,
  SearchInput,
  SegmentedControl,
  Select,
  TextArea,
  TextInput,
  Toggle,
  type FormFieldProps,
  type SearchInputProps,
  type SegmentedControlProps,
  type SelectOption,
  type SelectProps,
  type ToggleProps,
} from './Form';
export { HsnSearchBox, type HsnSearchBoxProps } from './HsnSearchBox';
export { KeyValueList, type KeyValueItem, type KeyValueListProps } from './KeyValueList';
export { KpiTile, StatGrid, type KpiAccent, type KpiDelta, type KpiTileProps, type StatGridProps } from './KpiTile';
export { LoadingBlock, ProgressBar, Skeleton, SkeletonRows, Spinner, type LoadingBlockProps } from './Loading';
export { Markdown, type MarkdownProps } from './Markdown';
export { Menu, type MenuItem, type MenuProps } from './Menu';
export { NetworkGraph, type NetworkGraphProps } from './NetworkGraph';
export { Drawer, Modal, type DrawerProps, type ModalProps } from './Overlay';
export { PageHeader, type Crumb, type PageHeaderProps } from './PageHeader';
export { ArchetypeBadge, CodeLink, MinistryPill, SectorPill, type CodeLinkProps, type MinistryLike, type MinistryPillProps, type SectorLike } from './Pills';
export {
  ModelEstimateTag,
  ProvenanceBadge,
  ProvenanceDot,
  ProvenanceLegend,
  sourceLabel,
  tradeSourceLabel,
  type ProvenanceBadgeProps,
  type ProvenanceLegendProps,
} from './Provenance';
export { QueryState, type QueryStateProps } from './QueryState';
export { ScoreBar, type ScoreBarProps } from './ScoreBar';
export { Sparkline, type SparklineProps } from './Sparkline';
export { Tabs, type TabDef, type TabsProps } from './Tabs';
export { ToastProvider, useToast, type ToastApi, type ToastInput, type ToastTone } from './Toast';
export { ReconciliationModal, ReconciliationHelpButton, type ReconciliationModalProps } from './ReconciliationModal';
export { Tooltip, type TooltipProps } from './Tooltip';
export { useAssistant, type AssistantContextValue } from './layout/AssistantContext';
