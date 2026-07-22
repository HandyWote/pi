import { Container, EntityList } from "@earendil-works/pi-tui";
import { getAvailableThemes } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { getEntityListTheme } from "./entity-list-theme.ts";

/**
 * Component that renders a theme selector
 */
export class ThemeSelectorComponent extends Container {
	private readonly selectList: EntityList;
	private readonly onPreview: (themeName: string) => void;

	constructor(
		currentTheme: string,
		onSelect: (themeName: string) => void,
		onCancel: () => void,
		onPreview: (themeName: string) => void,
	) {
		super();
		this.onPreview = onPreview;

		// Get available themes and create select items
		const themes = getAvailableThemes();
		const themeItems = themes.map((name) => ({
			id: name,
			label: name,
			description: name === currentTheme ? "(current)" : undefined,
		}));

		// Add top border
		this.addChild(new DynamicBorder());

		// Create selector
		this.selectList = new EntityList(themeItems, {
			theme: getEntityListTheme(),
			maxVisible: 10,
			initialSelectedId: currentTheme,
		});

		this.selectList.onActivate = (item) => {
			onSelect(item.id);
		};

		this.selectList.onCancel = () => {
			onCancel();
		};

		this.selectList.onSelectionChange = (item) => {
			this.onPreview(item.id);
		};

		this.addChild(this.selectList);

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	getSelectList(): EntityList {
		return this.selectList;
	}
}
