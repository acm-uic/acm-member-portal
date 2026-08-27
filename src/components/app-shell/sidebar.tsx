import { component$ } from "@builder.io/qwik";
import { Link, useLocation } from "@builder.io/qwik-city";
import { ThemeToggle } from "~/components/theme-toggle";

const NAV_ITEMS = [
	{ href: "/dashboard", label: "Overview", icon: "icon-layout-dashboard" },
	{
		href: "/dashboard/announcements",
		label: "Announcements",
		icon: "icon-megaphone",
	},
	{ href: "/dashboard/resources", label: "Resources", icon: "icon-book-open" },
	{ href: "/dashboard/profile", label: "Profile", icon: "icon-user" },
] as const;

const ADMIN_NAV_ITEMS = [
	{
		href: "/dashboard/admin/signups",
		label: "Signups",
		icon: "icon-user-plus",
	},
	{ href: "/dashboard/admin/members", label: "Members", icon: "icon-users" },
	{ href: "/dashboard/admin/roles", label: "Roles", icon: "icon-shield" },
	{
		href: "/dashboard/admin/forms",
		label: "Forms",
		icon: "icon-clipboard-list",
	},
	{ href: "/dashboard/admin/content", label: "Content", icon: "icon-file-text" },
	{
		href: "/dashboard/admin/alumni",
		label: "Alumni",
		icon: "icon-graduation-cap",
	},
] as const;

function navPath(pathname: string) {
	return pathname.replace(/\/+$/, "") || "/";
}

function isNavActive(pathname: string, href: string) {
	const path = navPath(pathname);
	const target = navPath(href);
	if (target === "/dashboard") return path === "/dashboard";
	return path === target || path.startsWith(`${target}/`);
}

function navClass(active: boolean) {
	return `flex items-center gap-sm h-[32px] px-sm rounded-control text-body-sm leading-none no-underline border-l-[3px] ${
		active
			? "bg-accent-subtle text-text1 border-accent"
			: "text-text2 border-transparent"
	}`;
}

/** Archetype sidebar (app-screen.html): 220px, wordmark, nav with 3px accent
    active border, profile + theme toggle pinned to the bottom. */
export const Sidebar = component$<{
	userName: string;
	userStatus: string;
	isAdmin: boolean;
}>((props) => {
	const loc = useLocation();
	const initials = props.userName
		.split(" ")
		.map((w) => w[0])
		.slice(0, 2)
		.join("")
		.toUpperCase();

	return (
		<aside class="w-[220px] shrink-0 self-start sticky top-0 h-screen flex flex-col px-sm py-lg border-r border-border bg-surface1">
			<div class="px-sm pb-lg font-display text-subheading font-bold">
				<span class="text-accent">ACM</span>@UIC
			</div>
			<nav class="grid gap-2xs content-start">
				{NAV_ITEMS.map((item) => (
					<Link
						key={item.href}
						href={item.href}
						class={navClass(isNavActive(loc.url.pathname, item.href))}
					>
						<i
							class={`icon ${item.icon} w-[14px] h-[14px] shrink-0 leading-none not-italic`}
							aria-hidden="true"
						/>
						<span>{item.label}</span>
					</Link>
				))}
				{props.isAdmin && (
					<>
						<p class="m-0 mt-md px-sm pt-sm text-caption text-text3 uppercase tracking-wider leading-none">
							Admin
						</p>
						{ADMIN_NAV_ITEMS.map((item) => (
							<Link
								key={item.href}
								href={item.href}
								class={navClass(isNavActive(loc.url.pathname, item.href))}
							>
								<i
									class={`icon ${item.icon} w-[14px] h-[14px] shrink-0 leading-none not-italic`}
									aria-hidden="true"
								/>
								<span>{item.label}</span>
							</Link>
						))}
					</>
				)}
			</nav>
			<div class="mt-auto pt-md border-t border-border flex items-center justify-between gap-sm px-sm">
				<div class="flex items-center gap-sm min-w-0">
					<div class="w-[34px] h-[34px] shrink-0 grid place-items-center rounded-pill bg-surface3 text-caption">
						{initials}
					</div>
					<div class="min-w-0">
						<strong class="block text-caption text-text1 truncate">
							{props.userName}
						</strong>
						<span class="block text-caption text-text3">
							{props.userStatus}
						</span>
					</div>
				</div>
				<ThemeToggle />
			</div>
		</aside>
	);
});
