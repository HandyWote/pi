import { Container, EntityList, Spacer, Text } from "@earendil-works/pi-tui";
import { APP_NAME } from "../../../config.ts";
import { type TerminalTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { getEntityListTheme } from "./entity-list-theme.ts";
import { keyHint } from "./keybinding-hints.ts";

export interface FirstTimeSetupResult {
	theme: TerminalTheme;
	shareAnalytics: boolean;
}

export interface FirstTimeSetupOptions {
	detectedTheme: TerminalTheme;
	onThemePreview: (themeName: TerminalTheme) => void;
	onSubmit: (result: FirstTimeSetupResult) => void;
	onCancel: () => void;
}

const THEME_OPTIONS: Array<{ value: TerminalTheme; label: string }> = [
	{ value: "dark", label: "Dark" },
	{ value: "light", label: "Light" },
];

const ANALYTICS_OPTIONS: Array<{ value: boolean; label: string }> = [
	{ value: true, label: "Share anonymous usage data" },
	{ value: false, label: "Don't share" },
];

const SETUP_LOGO_LINES = ["██████", "██  ██", "████  ██", "██    ██"];

/** First-time setup dialog: theme choice and analytics opt-in. */
export class FirstTimeSetupComponent extends Container {
	private step: "theme" | "analytics" = "theme";
	private themeIndex: number;
	private analyticsIndex = 0;
	private readonly options: FirstTimeSetupOptions;
	private list!: EntityList;

	constructor(options: FirstTimeSetupOptions) {
		super();
		this.options = options;
		this.themeIndex = Math.max(
			0,
			THEME_OPTIONS.findIndex((option) => option.value === options.detectedTheme),
		);
		this.update();
	}

	// Rebuild the whole dialog on every change so theme previews recolor all text.
	private update(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", SETUP_LOGO_LINES.join("\n")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(theme.fg("accent", theme.bold(`Welcome to ${APP_NAME}, the minimal coding agent.`)), 1, 0),
		);
		this.addChild(new Spacer(1));

		if (this.step === "theme") {
			this.addChild(new Text(theme.fg("text", "Pick a theme."), 1, 0));
			this.addChild(new Text(theme.fg("muted", `Detected system appearance: ${this.options.detectedTheme}`), 1, 0));
			this.addChild(new Spacer(1));
		} else {
			this.addChild(new Text(theme.fg("text", "Opt-in to anonymous usage data sharing?"), 1, 0));
			this.addChild(
				new Text(
					theme.fg(
						"muted",
						"Opting in stores a tracking identifier in settings.json and enables anonymous\nusage analytics. This helps us to better debug, reproduce, and resolve issues\nand bugs within Pi. You can observe what is shared using /privacy and make\nchanges anytime in settings.json.",
					),
					1,
					0,
				),
			);
			this.addChild(new Spacer(1));
		}

		const sourceOptions = this.step === "theme" ? THEME_OPTIONS : ANALYTICS_OPTIONS;
		const selectedIndex = this.step === "theme" ? this.themeIndex : this.analyticsIndex;
		this.list = new EntityList(
			sourceOptions.map((option, index) => ({ id: String(index), label: option.label })),
			{
				theme: getEntityListTheme(),
				maxVisible: sourceOptions.length,
				initialSelectedId: String(selectedIndex),
			},
		);
		this.list.onSelectionChange = (item) => {
			const index = Number(item.id);
			if (this.step === "theme") {
				this.themeIndex = index;
				this.options.onThemePreview(THEME_OPTIONS[index].value);
			} else {
				this.analyticsIndex = index;
			}
		};
		this.list.onActivate = () => {
			if (this.step === "theme") {
				this.step = "analytics";
				this.update();
			} else {
				this.options.onSubmit({
					theme: THEME_OPTIONS[this.themeIndex].value,
					shareAnalytics: ANALYTICS_OPTIONS[this.analyticsIndex].value,
				});
			}
		};
		this.list.onCancel = this.options.onCancel;
		this.addChild(this.list);

		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				keyHint("tui.entity.up", "navigate") +
					"  " +
					keyHint("tui.entity.activate", this.step === "theme" ? "continue" : "finish") +
					"  " +
					keyHint("tui.entity.cancel", "skip setup"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		this.list.handleInput(keyData);
	}
}
