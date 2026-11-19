import {
  AiBrain01Icon,
  Airplane01Icon,
  Analytics01Icon,
  AnchorIcon,
  Atom01Icon,
  Award01Icon,
  BirthdayCakeIcon,
  Book02Icon,
  Briefcase01Icon,
  BubbleChatIcon,
  Bug01Icon,
  Calendar03Icon,
  Camera01Icon,
  Car01Icon,
  ChartLineData01Icon,
  Clock01Icon,
  CloudIcon,
  Coffee01Icon,
  ColorsIcon,
  Compass01Icon,
  ComputerTerminal01Icon,
  CreditCardIcon,
  CrownIcon,
  DashboardSquare01Icon,
  Database01Icon,
  Diamond01Icon,
  FavouriteIcon,
  File01Icon,
  FireIcon,
  Flag01Icon,
  FlashIcon,
  Folder01Icon,
  GameController01Icon,
  GiftIcon,
  GitBranchIcon,
  Globe02Icon,
  HeadphonesIcon,
  Home01Icon,
  Idea01Icon,
  Image01Icon,
  Layers01Icon,
  Leaf01Icon,
  Link01Icon,
  Location01Icon,
  LockIcon,
  MagicWand01Icon,
  Mail01Icon,
  Moon02Icon,
  MusicNote01Icon,
  Notification01Icon,
  Package01Icon,
  PaintBoardIcon,
  PencilEdit01Icon,
  Pizza01Icon,
  Plant01Icon,
  PuzzleIcon,
  Robot01Icon,
  Rocket01Icon,
  School01Icon,
  ServerStack01Icon,
  Settings01Icon,
  Shield01Icon,
  ShoppingBag01Icon,
  ShoppingCart01Icon,
  SmileIcon,
  SourceCodeIcon,
  SparklesIcon,
  StarIcon,
  Store01Icon,
  Sun01Icon,
  Target02Icon,
  TestTube01Icon,
  Tree01Icon,
  UserGroupIcon,
  UserIcon,
  Wallet01Icon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  ProjectAvatar,
  ProjectAvatarColor,
  ProjectAvatarIcon,
} from "#/../shared/project-avatar";
import { cn } from "#/lib/utils";

/** Each curated name's icon; typed by the shared list so none goes missing. */
export const AVATAR_ICONS: Record<
  ProjectAvatarIcon,
  Parameters<typeof HugeiconsIcon>[0]["icon"]
> = {
  Rocket01Icon,
  SourceCodeIcon,
  ComputerTerminal01Icon,
  GitBranchIcon,
  Bug01Icon,
  Database01Icon,
  ServerStack01Icon,
  CloudIcon,
  Globe02Icon,
  Link01Icon,
  Layers01Icon,
  Package01Icon,
  DashboardSquare01Icon,
  Settings01Icon,
  Wrench01Icon,
  Shield01Icon,
  LockIcon,
  Robot01Icon,
  AiBrain01Icon,
  SparklesIcon,
  MagicWand01Icon,
  Briefcase01Icon,
  Analytics01Icon,
  ChartLineData01Icon,
  Wallet01Icon,
  CreditCardIcon,
  ShoppingCart01Icon,
  ShoppingBag01Icon,
  Store01Icon,
  Target02Icon,
  Flag01Icon,
  Award01Icon,
  Mail01Icon,
  BubbleChatIcon,
  Notification01Icon,
  Calendar03Icon,
  Clock01Icon,
  Folder01Icon,
  File01Icon,
  Book02Icon,
  School01Icon,
  PencilEdit01Icon,
  Home01Icon,
  UserIcon,
  UserGroupIcon,
  Location01Icon,
  Compass01Icon,
  Car01Icon,
  Airplane01Icon,
  AnchorIcon,
  PaintBoardIcon,
  ColorsIcon,
  Image01Icon,
  Camera01Icon,
  MusicNote01Icon,
  HeadphonesIcon,
  GameController01Icon,
  PuzzleIcon,
  Atom01Icon,
  TestTube01Icon,
  Idea01Icon,
  Sun01Icon,
  Moon02Icon,
  FlashIcon,
  FireIcon,
  Leaf01Icon,
  Plant01Icon,
  Tree01Icon,
  Coffee01Icon,
  Pizza01Icon,
  BirthdayCakeIcon,
  GiftIcon,
  Diamond01Icon,
  CrownIcon,
  StarIcon,
  FavouriteIcon,
  SmileIcon,
};

/** How each palette id is drawn: white marks on it, in both themes. */
export const AVATAR_COLORS: Record<ProjectAvatarColor, string> = {
  slate: "bg-slate-500",
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  green: "bg-green-600",
  teal: "bg-teal-500",
  sky: "bg-sky-500",
  blue: "bg-blue-600",
  violet: "bg-violet-500",
  pink: "bg-pink-500",
  sunset: "bg-linear-to-br from-amber-400 via-orange-500 to-rose-500",
  ocean: "bg-linear-to-br from-sky-400 to-blue-700",
  forest: "bg-linear-to-br from-lime-500 to-emerald-700",
  candy: "bg-linear-to-br from-pink-400 to-violet-600",
  dusk: "bg-linear-to-br from-indigo-500 via-purple-600 to-rose-500",
  aurora: "bg-linear-to-br from-teal-400 via-cyan-500 to-violet-600",
};

/** A palette id's name, for its swatch's label. */
export const AVATAR_COLOR_NAMES: Record<ProjectAvatarColor, string> = {
  slate: "Slate",
  red: "Red",
  orange: "Orange",
  amber: "Amber",
  green: "Green",
  teal: "Teal",
  sky: "Sky",
  blue: "Blue",
  violet: "Violet",
  pink: "Pink",
  sunset: "Sunset",
  ocean: "Ocean",
  forest: "Forest",
  candy: "Candy",
  dusk: "Dusk",
  aurora: "Aurora",
};

/**
 * A chosen avatar, drawn at whatever size `className` gives the tile (FE-162):
 * its letter, emoji or icon centred on its colour. The mark scales with the
 * tile: an icon takes 60% of it, an emoji a little over the font size.
 */
export function AvatarFace({
  avatar,
  className,
}: {
  avatar: ProjectAvatar;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-md font-semibold text-white select-none",
        AVATAR_COLORS[avatar.color],
        className,
      )}
    >
      {avatar.kind === "letter" ? (
        <span className="leading-none">{avatar.text}</span>
      ) : avatar.kind === "emoji" ? (
        <span className="text-[1.15em] leading-none">{avatar.emoji}</span>
      ) : (
        <HugeiconsIcon
          icon={AVATAR_ICONS[avatar.icon]}
          className="size-[60%]"
          strokeWidth={2}
        />
      )}
    </span>
  );
}
