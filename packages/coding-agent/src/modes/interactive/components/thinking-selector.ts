import type { ThinkingLevel } from "@handy_wote/pi-agent-core";
import { Container, EntityList } from "@handy_wote/pi-tui";
import { DynamicBorder } from "./dynamic-border.ts";
import { getEntityListTheme } from "./entity-list-theme.ts";

const LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

/**
 * Component that renders a thinking level selector with borders
 */
export class ThinkingSelectorComponent extends Container {
	private readonly selectList: EntityList;

	constructor(
		currentLevel: ThinkingLevel,
		availableLevels: ThinkingLevel[],
		onSelect: (level: ThinkingLevel) => void,
		onCancel: () => void,
	) {
		super();

		const thinkingLevels = availableLevels.map((level) => ({
			id: level,
			label: level,
			description: LEVEL_DESCRIPTIONS[level],
		}));

		// Add top border
		this.addChild(new DynamicBorder());

		// Create selector
		this.selectList = new EntityList(thinkingLevels, {
			theme: getEntityListTheme(),
			maxVisible: thinkingLevels.length,
			initialSelectedId: currentLevel,
		});

		this.selectList.onActivate = (item) => {
			onSelect(item.id as ThinkingLevel);
		};

		this.selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.selectList);

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	getSelectList(): EntityList {
		return this.selectList;
	}
}
