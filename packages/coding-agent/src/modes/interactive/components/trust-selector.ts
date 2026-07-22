import { Container, EntityList, Spacer, Text } from "@handy_wote/pi-tui";
import {
	getProjectTrustOptions,
	type ProjectTrustOption,
	type ProjectTrustStoreEntry,
} from "../../../core/trust-manager.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { getEntityListTheme } from "./entity-list-theme.ts";
import { keyHint } from "./keybinding-hints.ts";

export type TrustSelection = Pick<ProjectTrustOption, "trusted" | "updates">;

export interface TrustSelectorOptions {
	cwd: string;
	savedDecision: ProjectTrustStoreEntry | null;
	projectTrusted: boolean;
	onSelect: (selection: TrustSelection) => void;
	onCancel: () => void;
}

function formatDecision(trustPath: string | undefined, decision: ProjectTrustStoreEntry | null): string {
	if (decision === null) {
		return "none";
	}
	const label = decision.decision ? "trusted" : "untrusted";
	if (trustPath !== undefined && decision.path !== trustPath) {
		return `${label} (inherited from ${decision.path})`;
	}
	return `${label} (${decision.path})`;
}

export class TrustSelectorComponent extends Container {
	private readonly list: EntityList;
	private readonly trustOptions: ProjectTrustOption[];
	private readonly savedDecision: ProjectTrustStoreEntry | null;
	private readonly onSelectCallback: (selection: TrustSelection) => void;
	private readonly onCancelCallback: () => void;

	constructor(options: TrustSelectorOptions) {
		super();

		this.savedDecision = options.savedDecision;
		this.trustOptions = getProjectTrustOptions(options.cwd);
		const selectedIndex = Math.max(
			0,
			this.trustOptions.findIndex((option) => this.isSavedOption(option)),
		);
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Project trust")), 1, 0));
		this.addChild(new Text(theme.fg("muted", options.cwd), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					`Saved decision: ${formatDecision(this.trustOptions[0]?.savedPath, options.savedDecision)}`,
				),
				1,
				0,
			),
		);
		this.addChild(
			new Text(theme.fg("muted", `Current session: ${options.projectTrusted ? "trusted" : "untrusted"}`), 1, 0),
		);
		this.addChild(new Spacer(1));

		this.list = new EntityList(
			this.trustOptions.map((option, index) => ({
				id: String(index),
				label: `${option.label}${this.isSavedOption(option) ? " ✓" : ""}`,
			})),
			{
				theme: getEntityListTheme(),
				maxVisible: this.trustOptions.length,
				initialSelectedId: String(selectedIndex),
			},
		);
		this.list.onActivate = (item) => {
			const selected = this.trustOptions[Number(item.id)];
			if (selected) {
				this.onSelectCallback({ trusted: selected.trusted, updates: selected.updates });
			}
		};
		this.list.onCancel = this.onCancelCallback;
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				keyHint("tui.entity.up", "navigate") +
					"  " +
					keyHint("tui.entity.activate", "save") +
					"  " +
					keyHint("tui.entity.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	private isSavedOption(option: ProjectTrustOption): boolean {
		return (
			option.savedPath !== undefined &&
			this.savedDecision?.decision === option.trusted &&
			this.savedDecision.path === option.savedPath
		);
	}

	handleInput(keyData: string): void {
		this.list.handleInput(keyData);
	}
}
