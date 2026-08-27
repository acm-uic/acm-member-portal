import { component$ } from "@builder.io/qwik";
import { DISCORD_INVITE_URL } from "~/lib/discord-constants";

/**
 * Curated links hub. Links are a code constant for v1 — curated by officers,
 * changed rarely, reviewed via PR (FRD: "curated external links"; only hosted
 * content is DB-backed). Add a section by appending to RESOURCE_SECTIONS.
 */
const RESOURCE_SECTIONS = [
  {
    title: "Community",
    links: [
      {
        label: "Discord server",
        href: DISCORD_INVITE_URL,
        note: "Chapter chat and SIG channels",
      },
      {
        label: "GitHub org",
        href: "https://github.com/acm-uic",
        note: "Chapter projects and workshop code",
      },
    ],
  },
  {
    title: "Chapter",
    links: [
      {
        label: "Google Drive",
        href: "https://drive.google.com/drive/folders/acm-uic",
        note: "Meeting notes, budgets, forms",
      },
      {
        label: "ACM national",
        href: "https://www.acm.org",
        note: "Membership benefits and digital library",
      },
    ],
  },
  {
    title: "UIC",
    links: [
      {
        label: "UIC campus labs",
        href: "https://accc.uic.edu",
        note: "ACCC resources and printing",
      },
      {
        label: "CS department",
        href: "https://cs.uic.edu",
        note: "Advising and course info",
      },
    ],
  },
] as const;

export default component$(() => {
  return (
    <main class="p-xl grid gap-lg max-w-3xl">
      <header>
        <h1 class="font-display text-heading m-0">Resources</h1>
        <p class="text-text2 text-body m-0">
          Everything the chapter uses, in one place.
        </p>
      </header>

      {RESOURCE_SECTIONS.map((section) => (
        <section key={section.title} class="grid gap-sm">
          <h2 class="text-subheading m-0">{section.title}</h2>
          <div class="grid gap-sm">
            {section.links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                class="flex items-center justify-between gap-md bg-surface1 border border-border rounded-component p-md no-underline group"
              >
                <div>
                  <span class="text-label text-text1 group-hover:text-accent">
                    {link.label}
                  </span>
                  <span class="block text-caption text-text3">{link.note}</span>
                </div>
                <i
                  class="icon icon-external-link text-text3"
                  aria-hidden="true"
                />
              </a>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
});
