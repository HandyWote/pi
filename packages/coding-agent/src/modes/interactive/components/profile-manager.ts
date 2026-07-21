import type { Profile } from "../../../core/profiles-types.ts";

export interface ProfileManagerCallbacks {
	onSelect: (profile: Profile) => void;
	onCreate: () => void;
	onEdit: (profile: Profile) => void;
	onDelete: (profile: Profile) => void;
	onCancel: () => void;
}

export class ProfileManagerComponent {
	private profiles: readonly Profile[];
	private callbacks: ProfileManagerCallbacks;
	private selectedIndex = 0;

	constructor(profiles: readonly Profile[], callbacks: ProfileManagerCallbacks) {
		this.profiles = profiles;
		this.callbacks = callbacks;
	}

	render(): string {
		if (this.profiles.length === 0) {
			return ["No profiles configured.", "", "  [c] Create Profile", "  [q] Quit"].join("\n");
		}

		const lines = ["Available profiles:", ""];
		for (let i = 0; i < this.profiles.length; i++) {
			const p = this.profiles[i];
			const cursor = i === this.selectedIndex ? ">" : " ";
			const enabledCount = p.models.filter((m) => m.enabled).length;
			lines.push(` ${cursor} ${p.name}  (${p.protocol}, ${p.models.length} models, ${enabledCount} enabled)`);
		}
		lines.push("");
		lines.push("  [Enter] Select  [c] Create  [e] Edit  [d] Delete  [q] Cancel");
		return lines.join("\n");
	}

	handleKey(key: string): boolean {
		switch (key) {
			case "up":
				if (this.selectedIndex > 0) this.selectedIndex--;
				return true;
			case "down":
				if (this.selectedIndex < this.profiles.length - 1) this.selectedIndex++;
				return true;
			case "enter":
				if (this.profiles.length > 0) {
					this.callbacks.onSelect(this.profiles[this.selectedIndex]);
				}
				return true;
			case "c":
				this.callbacks.onCreate();
				return true;
			case "e":
				if (this.profiles.length > 0) {
					this.callbacks.onEdit(this.profiles[this.selectedIndex]);
				}
				return true;
			case "d":
				if (this.profiles.length > 0) {
					this.callbacks.onDelete(this.profiles[this.selectedIndex]);
				}
				return true;
			case "escape":
			case "q":
				this.callbacks.onCancel();
				return true;
			default:
				return false;
		}
	}
}
