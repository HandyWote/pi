import { Container, EntityList, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { getEntityListTheme } from "./entity-list-theme.ts";

interface UserMessageItem {
	id: string; // Entry ID in the session
	text: string; // The message text
	timestamp?: string; // Optional timestamp if available
}

/**
 * Component that renders a user message selector for branching
 */
export class UserMessageSelectorComponent extends Container {
	private readonly messageList: EntityList;

	constructor(
		messages: UserMessageItem[],
		onSelect: (entryId: string) => void,
		onCancel: () => void,
		initialSelectedId?: string,
	) {
		super();

		// Add header
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Fork from Message"), 1, 0));
		this.addChild(
			new Text(
				theme.fg("muted", "Select a user message to copy the active path up to that point into a new session"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		const messageById = new Map(messages.map((message) => [message.id, message]));
		const positionById = new Map(messages.map((message, index) => [message.id, index + 1]));
		this.messageList = new EntityList(
			messages.map((message) => ({ id: message.id, label: message.text })),
			{
				theme: getEntityListTheme(),
				maxVisible: 10,
				initialSelectedId: initialSelectedId ?? messages[messages.length - 1]?.id,
				renderEmpty: () => [theme.fg("muted", "  No user messages found")],
				renderItem: ({ item, selected, width }) => {
					const message = messageById.get(item.id);
					if (!message) return [];
					const normalizedMessage = message.text.replace(/\n/g, " ").trim();
					const cursor = selected ? theme.fg("accent", "› ") : "  ";
					const truncatedMessage = truncateToWidth(normalizedMessage, Math.max(1, width - 2));
					const messageLine = cursor + (selected ? theme.bold(truncatedMessage) : truncatedMessage);
					const metadata = theme.fg("muted", `  Message ${positionById.get(item.id) ?? 0} of ${messages.length}`);
					return [messageLine, metadata, ""];
				},
			},
		);
		this.messageList.onActivate = (item) => onSelect(item.id);
		this.messageList.onCancel = onCancel;

		this.addChild(this.messageList);

		// Add bottom border
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		// Auto-cancel if no messages
		if (messages.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	getMessageList(): EntityList {
		return this.messageList;
	}
}
