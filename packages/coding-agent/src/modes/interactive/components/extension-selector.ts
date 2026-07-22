/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 */

import { Container, EntityList, getKeybindings, Spacer, Text, type TUI } from "@handy_wote/pi-tui";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { getEntityListTheme } from "./entity-list-theme.ts";
import { keyHint } from "./keybinding-hints.ts";

export interface ExtensionSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onToggleToolsExpanded?: () => void;
}

export class ExtensionSelectorComponent extends Container {
	private readonly list: EntityList;
	private readonly onCancelCallback: () => void;
	private readonly titleText: Text;
	private readonly baseTitle: string;
	private countdown: CountdownTimer | undefined;
	private readonly onToggleToolsExpanded: (() => void) | undefined;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		super();

		this.onCancelCallback = onCancel;
		this.onToggleToolsExpanded = opts?.onToggleToolsExpanded;
		this.baseTitle = title;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setText(theme.fg("accent", theme.bold(`${this.baseTitle} (${s}s)`))),
				() => this.onCancelCallback(),
			);
		}

		this.list = new EntityList(
			options.map((option, index) => ({ id: String(index), label: option })),
			{ theme: getEntityListTheme(), maxVisible: Math.max(5, options.length) },
		);
		this.list.onActivate = (item) => {
			const option = options[Number(item.id)];
			if (option !== undefined) onSelect(option);
		};
		this.list.onCancel = onCancel;
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				keyHint("tui.entity.up", "navigate") +
					"  " +
					keyHint("tui.entity.activate", "select") +
					"  " +
					keyHint("tui.entity.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
		} else {
			this.list.handleInput(keyData);
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
