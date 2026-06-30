import {
	Coins01Icon,
	DashboardSquare01Icon,
	HelpCircleIcon,
	Logout01Icon,
	UnfoldMoreIcon,
	UserIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import { RepoSwitcher } from "@/components/repo-switcher";
import { TagMore } from "@/components/tag-more";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOut } from "@/lib/auth-client";
import { tagColor } from "@/lib/tag-color";
import { cn } from "@/lib/utils";

export interface SidebarNav {
	owner: string;
	repo: string;
	mine: boolean;
	tag?: string;
	totalCount: number;
	myCount: number;
	/** All tags, sorted by count desc. */
	tags: { name: string; count: number }[];
	/** True when the Cost page is active (so "Tasks" isn't also highlighted). */
	cost?: boolean;
}

interface AppSidebarProps {
	user: { name: string; image: string | null };
	active?: { owner: string; repo: string };
	nav?: SidebarNav;
}

const TOP_TAGS = 5;

export function AppSidebar({ user, active, nav }: AppSidebarProps) {
	const topTags = nav?.tags.slice(0, TOP_TAGS) ?? [];

	return (
		<aside className="flex w-64 shrink-0 flex-col gap-3 border-r bg-sidebar p-3 text-sidebar-foreground">
			{/* Header: searchable repo switcher */}
			<div className="pt-1">
				<RepoSwitcher active={active} className="w-full" />
			</div>

			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
				{nav ? (
					<>
						{/* Main */}
						<Section title="Main">
							<NavItem
								owner={nav.owner}
								repo={nav.repo}
								search={{}}
								active={!nav.mine && !nav.tag && !nav.cost}
								icon={DashboardSquare01Icon}
								label="Tasks"
								count={nav.totalCount}
							/>
							{/* No real user in local mode (synthetic viewer) — hide "My tasks". */}
							{!__LANEWORK_LOCAL__ ? (
								<NavItem
									owner={nav.owner}
									repo={nav.repo}
									search={{ mine: true }}
									active={nav.mine}
									icon={UserIcon}
									label="My tasks"
									count={nav.myCount}
								/>
							) : null}
							{/* Cost reads ~/.claude transcripts — local CLI only. */}
							{__LANEWORK_LOCAL__ ? (
								<Link
									to="/board/$owner/$repo/cost"
									params={{ owner: nav.owner, repo: nav.repo }}
									className={rowClass}
									activeProps={{ className: rowActive }}
									inactiveProps={{ className: rowIdle }}
								>
									<HugeiconsIcon
										icon={Coins01Icon}
										className="size-4 shrink-0 text-muted-foreground"
									/>
									<span className="flex-1">Cost</span>
								</Link>
							) : null}
						</Section>

						{/* Tags */}
						{nav.tags.length > 0 ? (
							<Section title="Tags">
								{topTags.map((t) => (
									<Link
										key={t.name}
										to="/board/$owner/$repo"
										params={{ owner: nav.owner, repo: nav.repo }}
										search={{ tag: t.name }}
										className={cn(
											rowClass,
											nav.tag === t.name ? rowActive : rowIdle,
										)}
									>
										<span
											className={cn(
												"size-2 shrink-0 rounded-full",
												tagColor(t.name),
											)}
										/>
										<span className="min-w-0 flex-1 truncate">{t.name}</span>
										<CountBadge n={t.count} />
									</Link>
								))}
								{nav.tags.length > TOP_TAGS ? (
									<TagMore
										owner={nav.owner}
										repo={nav.repo}
										tags={nav.tags}
										activeTag={nav.tag}
									/>
								) : null}
							</Section>
						) : null}
					</>
				) : (
					<p className="px-2 pt-2 text-xs text-muted-foreground">
						Select a project to see its tasks and tags.
					</p>
				)}
			</div>

			{/* Help */}
			<Link
				to="/guide"
				className={rowClass}
				activeProps={{ className: rowActive }}
				inactiveProps={{ className: rowIdle }}
			>
				<HugeiconsIcon
					icon={HelpCircleIcon}
					className="size-4 shrink-0 text-muted-foreground"
				/>
				How to use?
			</Link>

			{/* Account dropdown — hosted only (local mode has no auth, so no identity row). */}
			{!__LANEWORK_LOCAL__ ? (
				<DropdownMenu>
					<DropdownMenuTrigger
						className={cn(
							"flex items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent",
						)}
					>
						<Avatar size="sm">
							{user.image ? (
								<AvatarImage src={user.image} alt={user.name} />
							) : null}
							<AvatarFallback>
								{user.name.slice(0, 2).toUpperCase()}
							</AvatarFallback>
						</Avatar>
						<span className="min-w-0 flex-1 truncate text-sm font-medium">
							{user.name}
						</span>
						<HugeiconsIcon
							icon={UnfoldMoreIcon}
							className="size-4 shrink-0 text-muted-foreground"
						/>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						side="top"
						align="start"
						sideOffset={6}
						className="min-w-(--anchor-width)"
					>
						<DropdownMenuItem
							variant="destructive"
							onClick={() =>
								signOut({
									fetchOptions: { onSuccess: () => window.location.reload() },
								})
							}
						>
							<HugeiconsIcon icon={Logout01Icon} />
							Logout
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}
		</aside>
	);
}

const rowClass =
	"flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors";
const rowActive =
	"bg-card font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.05)] ring-1 ring-border/70";
const rowIdle =
	"text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";

function Section({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div>
			<div className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
				{title}
			</div>
			<div className="flex flex-col gap-0.5 px-1">{children}</div>
		</div>
	);
}

function NavItem({
	owner,
	repo,
	search,
	active,
	icon,
	label,
	count,
}: {
	owner: string;
	repo: string;
	search: { mine?: boolean; tag?: string };
	active: boolean;
	icon: typeof UserIcon;
	label: string;
	count: number;
}) {
	return (
		<Link
			to="/board/$owner/$repo"
			params={{ owner, repo }}
			search={search}
			className={cn(rowClass, active ? rowActive : rowIdle)}
		>
			<HugeiconsIcon icon={icon} className={cn("size-4 shrink-0")} />
			<span className="flex-1">{label}</span>
			<CountBadge n={count} />
		</Link>
	);
}

function CountBadge({ n }: { n: number }) {
	return (
		<span className="ml-auto rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
			{n}
		</span>
	);
}
