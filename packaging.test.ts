import { expect, test } from "bun:test";
import { join } from "node:path";

const root = import.meta.dir;
const pkg = await Bun.file(join(root, "package.json")).json();
const catalog = await Bun.file(join(root, ".omp-plugin/marketplace.json")).json();

test("package exposes only its extension entry point and declares public metadata", async () => {
	expect(pkg.omp.extensions).toEqual(["./index.ts"]);
	expect(await Bun.file(join(root, pkg.omp.extensions[0])).exists()).toBe(true);
	expect(pkg.license).toBe("MIT");
	expect(pkg.repository.url).toBe("https://github.com/jralph/omp-history.git");
	expect(pkg.homepage).toContain("https://github.com/jralph/omp-history");
	expect(pkg.bugs.url).toBe("https://github.com/jralph/omp-history/issues");
	expect(pkg.keywords).toContain("oh-my-pi");
	expect(await Bun.file(join(root, "LICENSE")).text()).toContain("MIT License");
});

test("marketplace points to this package and versions stay in sync", () => {
	expect(catalog.name).toBe("jralph-omp-history");
	expect(catalog.owner.name).toBe("jralph");
	expect(catalog.metadata.version).toBe(pkg.version);
	expect(catalog.plugins).toHaveLength(1);
	const plugin = catalog.plugins[0];
	expect(plugin.name).toBe("omp-history");
	expect(plugin.source).toBe("./");
	expect(plugin.version).toBe(pkg.version);
	expect(plugin.license).toBe(pkg.license);
});
