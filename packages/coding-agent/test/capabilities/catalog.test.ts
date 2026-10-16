import { describe, expect, it } from "vitest";
import { CapabilityCatalog, type SkillCapability } from "../../src/core/capabilities/catalog.ts";

function skillRecord(overrides: Partial<SkillCapability> = {}): SkillCapability {
	return {
		kind: "skill",
		id: "pdf-processing",
		name: "pdf-processing",
		description: "Extract PDF text and fill forms",
		scope: "user",
		source: "builtin",
		state: "discovered",
		available: true,
		skillDir: "/skills/pdf-processing",
		invocationPolicy: "implicit-allowed",
		updatedAt: Date.now(),
		...overrides,
	};
}

describe("CapabilityCatalog", () => {
	it("upserts, transitions, and bumps version on change", () => {
		const catalog = new CapabilityCatalog();
		expect(catalog.currentVersion).toBe(1);

		catalog.upsert(skillRecord());
		expect(catalog.currentVersion).toBe(2);
		catalog.upsert(skillRecord()); // identical record, no bump
		expect(catalog.currentVersion).toBe(2);

		catalog.transition("skill", "pdf-processing", "listed");
		expect(catalog.currentVersion).toBe(3);
		const listed = catalog.get("skill", "pdf-processing");
		expect(listed?.state).toBe("listed");
	});

	it("keeps registered, selected, and available distinct", () => {
		const catalog = new CapabilityCatalog();
		catalog.upsert({
			kind: "tool",
			id: "mcp__github__create_issue",
			name: "create_issue",
			scope: "plugin",
			source: "github-plugin",
			state: "registered",
			available: false,
			owner: "github-plugin",
			exposure: "deferred",
			updatedAt: Date.now(),
		});
		const registered = catalog.get("tool", "mcp__github__create_issue");
		expect(registered?.state).toBe("registered");
		expect(catalog.available("tool")).toHaveLength(0);

		catalog.transition("tool", "mcp__github__create_issue", "active", { available: true });
		expect(catalog.available("tool")).toHaveLength(1);
	});

	it("filters implicitly invocable skills", () => {
		const catalog = new CapabilityCatalog();
		catalog.upsert(skillRecord());
		catalog.upsert(
			skillRecord({
				id: "explicit-only",
				name: "explicit-only",
				invocationPolicy: "explicit-only",
			}),
		);
		catalog.upsert(
			skillRecord({
				id: "unavailable",
				name: "unavailable",
				available: false,
			}),
		);
		const invocable = catalog.implicitlyInvocableSkills();
		expect(invocable.map((s) => s.id)).toEqual(["pdf-processing"]);
	});

	it("notifies invalidation listeners and allows unsubscription", () => {
		const catalog = new CapabilityCatalog();
		let invalidated = 0;
		const unsubscribe = catalog.onInvalidation(() => invalidated++);
		catalog.upsert(skillRecord());
		expect(invalidated).toBe(1);
		unsubscribe();
		catalog.remove("skill", "pdf-processing");
		expect(invalidated).toBe(1);
	});

	it("removes records by source (plugin uninstall)", () => {
		const catalog = new CapabilityCatalog();
		catalog.upsert(skillRecord({ id: "a", name: "a", source: "my-plugin", scope: "plugin" }));
		catalog.upsert(skillRecord({ id: "b", name: "b", source: "my-plugin", scope: "plugin" }));
		catalog.upsert(skillRecord({ id: "c", name: "c" }));
		const removed = catalog.removeBySource("my-plugin");
		expect(removed).toBe(2);
		expect(catalog.list("skill").map((s) => s.id)).toEqual(["c"]);
	});

	it("produces a stable content digest for decision cache keys", () => {
		const a = new CapabilityCatalog();
		const b = new CapabilityCatalog();
		a.upsert(skillRecord());
		b.upsert(skillRecord());
		expect(a.digest()).toBe(b.digest());

		b.transition("skill", "pdf-processing", "listed");
		expect(a.digest()).not.toBe(b.digest());
	});

	it("snapshots include version and records", () => {
		const catalog = new CapabilityCatalog();
		catalog.upsert(skillRecord());
		const snapshot = catalog.snapshot();
		expect(snapshot.schemaVersion).toBe(1);
		expect(snapshot.records).toHaveLength(1);
		expect(snapshot.version).toBe(2);
	});
});
