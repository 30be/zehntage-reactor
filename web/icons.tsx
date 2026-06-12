// Central icon module: thin wrappers over lucide-react (tree-shakeable).
// One place defines the app-wide stroke weight + default size so every icon
// renders with the same visual density (japanese × german-precision: quiet,
// consistent, currentColor only).

import {
  BookOpen,
  ChartNoAxesColumn,
  ChevronLeft,
  ChevronRight,
  GalleryVerticalEnd,
  House,
  LayoutGrid,
  Maximize,
  MonitorPlay,
  Pause,
  Play,
  RotateCw,
  Settings,
  Volume2,
  VolumeX,
  type LucideProps,
} from "lucide-react";

const STROKE = 1.75;

type IconCmp = React.ComponentType<LucideProps>;

function wrap(Cmp: IconCmp, defaultSize: number) {
  return function Icon(p: LucideProps) {
    return <Cmp size={defaultSize} strokeWidth={STROKE} aria-hidden {...p} />;
  };
}

// player controls (vbar default 18, fullscreen passes 20)
export const PlayIcon = wrap(Play, 18);
export const PauseIcon = wrap(Pause, 18);
export const VolumeIcon = wrap(Volume2, 18);
export const VolumeXIcon = wrap(VolumeX, 18);
export const MaximizeIcon = wrap(Maximize, 18);
export const RotateCwIcon = wrap(RotateCw, 16);
export const ChevronLeftIcon = wrap(ChevronLeft, 16);
export const ChevronRightIcon = wrap(ChevronRight, 16);
export const BookOpenIcon = wrap(BookOpen, 16);

// sidebar navigation
export const HomeIcon = wrap(House, 17);
export const LibraryIcon = wrap(LayoutGrid, 17);
export const ViewIcon = wrap(MonitorPlay, 17);
export const CardsIcon = wrap(GalleryVerticalEnd, 17);
export const StatsIcon = wrap(ChartNoAxesColumn, 17);
export const SettingsIcon = wrap(Settings, 17);
