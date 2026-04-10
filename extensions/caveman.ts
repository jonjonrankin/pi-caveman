/**
 * pi-caveman — why use many token when few do trick
 *
 * A pi extension that cuts ~75% of output tokens while keeping full technical
 * accuracy. Based on https://github.com/JuliusBrussee/caveman
 *
 * Commands:
 *   /caveman [level]  Toggle caveman mode or set intensity
 *                     Levels: lite | full | ultra | wenyan-lite | wenyan | wenyan-ultra | off
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

const LEVELS = ["off", "lite", "full", "ultra", "wenyan-lite", "wenyan", "wenyan-ultra"] as const;
type Level = (typeof LEVELS)[number];

// ---------------------------------------------------------------------------
// Animated status bar — block-element pixel art, per-level animations
// ---------------------------------------------------------------------------

interface Animation {
	frames: string[];
	/** Label shown after the icon */
	label: string;
	/** ms between frames */
	interval: number;
}

// Block-element frames give a chunky, pixelated terminal feel.
// Each animation is a short loop designed for a single-line footer slot.

const ANIMATIONS: Record<Exclude<Level, "off">, Animation> = {
	// Lite: gentle breathing pulse
	lite: {
		frames: ["░▒░", "▒▓▒", "▓█▓", "▒▓▒"],
		label: "LITE",
		interval: 500,
	},
	// Full: throbbing rock
	full: {
		frames: ["▓█▓", "█▓█", "▓░▓", "█▓█"],
		label: "CAVEMAN",
		interval: 400,
	},
	// Ultra: fast fire shimmer
	ultra: {
		frames: ["░▒▓", "▒▓█", "▓█▒", "█▓░", "▓▒░"],
		label: "ULTRA",
		interval: 150,
	},
	// Wenyan modes: flowing scroll
	"wenyan-lite": {
		frames: ["▐░▌", "▐▒▌", "▐▓▌", "▐▒▌"],
		label: "文言",
		interval: 500,
	},
	wenyan: {
		frames: ["▐▓▌", "▐█▌", "▐▓▌", "▐▒▌"],
		label: "文言文",
		interval: 400,
	},
	"wenyan-ultra": {
		frames: ["▐░▌", "▐▓▌", "▐█▌", "▐▓▌", "▐░▌"],
		label: "文言文極",
		interval: 200,
	},
};

// ---------------------------------------------------------------------------
// System prompt fragments
// ---------------------------------------------------------------------------

const BASE = `\
IMPORTANT: You are in CAVEMAN MODE. Respond terse like smart caveman. \
All technical substance stay. Only fluff die.

Rules:
- Drop articles (a/an/the), filler (just/really/basically/actually/simply), \
pleasantries, hedging
- Fragments OK. Short synonyms preferred. Technical terms exact
- Code blocks unchanged. Errors quoted exact
- Pattern: [thing] [action] [reason]. [next step].

Bad: "Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by..."
Good: "Bug in auth middleware. Token expiry check use \`<\` not \`<=\`. Fix:"`;

const INTENSITY: Record<Exclude<Level, "off">, string> = {
	lite: `\
Level: LITE — No filler/hedging. Keep articles + full sentences. Professional but tight.
Example: "Your component re-renders because you create a new object reference each render. Wrap it in \`useMemo\`."`,

	full: `\
Level: FULL — Drop articles, fragments OK, short synonyms. Classic caveman.
Example: "New object ref each render. Inline object prop = new ref = re-render. Wrap in \`useMemo\`."`,

	ultra: `\
Level: ULTRA — Abbreviate (DB/auth/config/req/res/fn/impl), strip conjunctions, arrows for causality (X → Y).
Example: "Inline obj prop → new ref → re-render. \`useMemo\`."`,

	"wenyan-lite": `\
Level: 文言文 LITE — Semi-classical Chinese. Grammar intact, filler gone. Technical terms in English.
Example: "組件頻重繪，以每繪新生對象參照故。以 useMemo 包之。"`,

	wenyan: `\
Level: 文言文 FULL — Maximum classical terseness. 80-90% character reduction. Technical terms in English.
Example: "物出新參照，致重繪。useMemo Wrap之。"`,

	"wenyan-ultra": `\
Level: 文言文 ULTRA — Extreme classical compression. Technical terms in English.
Example: "新參照→重繪。useMemo Wrap。"`,
};

const SAFETY = `\
Auto-clarity: drop caveman for security warnings, irreversible action confirmations, \
or when user is confused. Resume after.
Boundaries: write normal code. Only compress explanations. "stop caveman" or "normal mode" reverts.`;

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function caveman(pi: ExtensionAPI) {
	let level: Level = "off";
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;

	// -- Animation helpers --

	function stopAnimation() {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
	}

	function syncStatus(ctx: Pick<ExtensionContext, "ui">) {
		stopAnimation();
		const theme = ctx.ui.theme;

		if (level === "off") {
			ctx.ui.setStatus("caveman", "");
			return;
		}

		const anim = ANIMATIONS[level];

		// Render one frame immediately, then start cycling
		const renderFrame = () => {
			const icon = anim.frames[frameIndex % anim.frames.length]!;
			ctx.ui.setStatus("caveman", theme.fg("dim", icon) + " " + theme.fg("muted", "caveman level: ") + theme.fg("text", anim.label));
			frameIndex++;
		};

		renderFrame();
		timer = setInterval(renderFrame, anim.interval);
	}

	// -- Restore persisted level on session load --

	pi.on("session_start", async (_event, ctx) => {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "caveman-level") {
				level = (entry.data as { level: Level })?.level ?? "off";
			}
		}
		syncStatus(ctx);
	});

	// -- Clean up timer on shutdown --

	pi.on("session_shutdown", async () => {
		stopAnimation();
	});

	// -- /caveman command --

	pi.registerCommand("caveman", {
		description: "Toggle caveman mode or set level: lite, full, ultra, wenyan-lite, wenyan, wenyan-ultra, off",
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();

			if (!arg) {
				level = level === "off" ? "full" : "off";
			} else if (LEVELS.includes(arg as Level)) {
				level = arg as Level;
			} else {
				ctx.ui.notify(`Unknown level "${arg}". Options: ${LEVELS.join(", ")}`, "error");
				return;
			}

			pi.appendEntry("caveman-level", { level });
			syncStatus(ctx);

			ctx.ui.notify(
				level === "off" ? "Caveman mode off." : `Caveman: ${ANIMATIONS[level].label}`,
				"info",
			);
		},
	});

	// -- Inject caveman rules into system prompt --

	pi.on("before_agent_start", async (event) => {
		if (level === "off") return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${BASE}\n\n${INTENSITY[level]}\n\n${SAFETY}`,
		};
	});
}
