import { component$ } from "@builder.io/qwik";
import { Link, useLocation } from "@builder.io/qwik-city";
import { ThemeToggle } from "~/components/theme-toggle";

const NAV_ITEMS = [
	{ href: "/dashboard", label: "Overview", icon: "icon-layout-dashboard" },
	{ href: "/announcements", label: "Announcements", icon: "icon-megaphone" },
	{ href: "/resources", label: "Resources", icon: "icon-book-open" },
	{ href: "/profile", label: "Profile", icon: "icon-user" },
] as const;

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
		<aside class="w-[220px] shrink-0 min-h-screen flex flex-col px-sm py-lg border-r border-border bg-surface1">
			<div class="px-sm pb-lg font-display text-subheading font-bold">
				<span class="text-accent">ACM</span>@UIC
			</div>
			<nav class="grid gap-2xs">
				{NAV_ITEMS.map((item) => {
					const active = loc.url.pathname.startsWith(item.href);
					return (
						<Link
							key={item.href}
							href={item.href}
							class={`flex items-center gap-sm px-sm py-sm rounded-control text-body-sm no-underline border-l-[3px] ${
								active
									? "bg-accent-subtle text-text1 border-accent"
									: "text-text2 border-transparent"
							}`}
						>
							<i class={`icon ${item.icon}`} aria-hidden="true" />
							<span>{item.label}</span>
						</Link>
					);
				})}
				{props.isAdmin && (
					<Link
						href="/admin/signups"
						class={`flex items-center gap-sm px-sm py-sm rounded-control text-body-sm no-underline border-l-[3px] ${
							loc.url.pathname.startsWith("/admin")
								? "bg-accent-subtle text-text1 border-accent"
								: "text-text2 border-transparent"
						}`}
					>
						<i class="icon icon-settings" aria-hidden="true" />
						<span>Admin</span>
					</Link>
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
