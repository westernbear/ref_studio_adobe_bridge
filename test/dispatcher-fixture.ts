import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  type AdobeCommandResultV1,
  AdobeCommandResultV1Schema,
} from "../src/contracts.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const clone = <T>(value: T): T => structuredClone(value);

class FakeProperty {
  public expression = "";
  public value: unknown = null;
  public readonly keys: {
    frameTime: number;
    value: unknown;
    easing: string;
  }[] = [];
  public readonly children = new Map<string, FakeProperty>();
  public constructor(public readonly name: string) {}
  public setValue(value: unknown): void {
    this.value = clone(value);
  }
  public setValueAtTime(frameTime: number, value: unknown): void {
    this.keys.push({ frameTime, value: clone(value), easing: "linear" });
  }
  public setTemporalEaseAtKey(index: number, easing: string): void {
    const key = this.keys[index - 1];
    if (key) key.easing = easing;
  }
  public addProperty(name: string): FakeProperty {
    const property = new FakeProperty(
      name === "ADBE Drop Shadow" ? "Drop Shadow" : name,
    );
    this.children.set(`${name}:${this.children.size + 1}`, property);
    return property;
  }
  public property(name: string): FakeProperty {
    if (typeof name === "number")
      return (
        [...this.children.values()][name - 1] ?? new FakeProperty("missing")
      );
    const existing = [...this.children.values()].find(
      (property) => property.name === name,
    );
    if (existing) return existing;
    const property = new FakeProperty(name);
    this.children.set(name, property);
    return property;
  }
  public get numProperties(): number {
    return this.children.size;
  }
  public get numKeys(): number {
    return this.keys.length;
  }
  public keyTime(index: number): number {
    return this.keys[index - 1]?.frameTime ?? 0;
  }
  public keyValue(index: number): unknown {
    return clone(this.keys[index - 1]?.value);
  }
  public keyEasing(index: number): string {
    return this.keys[index - 1]?.easing ?? "linear";
  }
}

class FakeLayer {
  public readonly properties = new Map<string, FakeProperty>();
  public kind = "layer";
  public source: unknown = null;
  public constructor(
    public readonly id: number,
    public name: string,
    private readonly owner: FakeLayers,
  ) {}
  public property(name: string | number): FakeProperty {
    if (typeof name === "number")
      return (
        [...this.properties.values()][name - 1] ?? new FakeProperty("missing")
      );
    const property = this.properties.get(name) ?? new FakeProperty(name);
    this.properties.set(name, property);
    return property;
  }
  public get numProperties(): number {
    return this.properties.size;
  }
  public duplicate(): FakeLayer {
    return this.owner.duplicate(this);
  }
  public remove(): void {
    this.owner.remove(this);
  }
}

class FakeLayers {
  public values: FakeLayer[] = [];
  public constructor(private readonly allocateId: () => number) {}
  public seed(): void {
    const title = this.add("Title", "text");
    title.source = "Title";
  }
  private add(name: string, kind: string): FakeLayer {
    const layer = new FakeLayer(this.allocateId(), name, this);
    layer.kind = kind;
    this.values.push(layer);
    return layer;
  }
  public addText(text: string): FakeLayer {
    const layer = this.add("Text", "text");
    layer.source = text;
    return layer;
  }
  public addSolid(color: unknown, name: string): FakeLayer {
    const layer = this.add(name, "solid");
    layer.source = clone(color);
    return layer;
  }
  public addCamera(name: string): FakeLayer {
    return this.add(name, "camera");
  }
  public addNull(): FakeLayer {
    return this.add("Null", "null");
  }
  public addShape(): FakeLayer {
    return this.add("Shape", "shape");
  }
  public duplicate(source: FakeLayer): FakeLayer {
    const duplicate = this.add(`${source.name} copy`, source.kind);
    duplicate.source = clone(source.source);
    for (const [name, property] of source.properties) {
      const copied = duplicate.property(name);
      copied.value = clone(property.value);
      copied.expression = property.expression;
      copied.keys.push(...clone(property.keys));
    }
    return duplicate;
  }
  public remove(layer: FakeLayer): void {
    this.values = this.values.filter((candidate) => candidate !== layer);
  }
  public get length(): number {
    return this.values.length;
  }
  public layer(index: number): FakeLayer | undefined {
    return this.values[index - 1];
  }
  public restore(values: readonly SavedLayer[]): void {
    this.values = values.map((saved) => {
      const layer = new FakeLayer(saved.id, saved.name, this);
      layer.kind = saved.kind;
      layer.source = clone(saved.source);
      for (const property of saved.properties) {
        const target = layer.property(property.name);
        target.value = clone(property.value);
        target.expression = property.expression;
        target.keys.push(...clone(property.keys));
        for (const child of property.children) {
          const added = target.addProperty(child.matchName);
          added.value = clone(child.value);
          added.expression = child.expression;
        }
      }
      return layer;
    });
  }
}

type SavedLayer = {
  readonly id: number;
  readonly name: string;
  readonly kind: string;
  readonly source: unknown;
  readonly properties: readonly {
    readonly name: string;
    readonly value: unknown;
    readonly expression: string;
    readonly keys: readonly {
      frameTime: number;
      value: unknown;
      easing: string;
    }[];
    readonly children: readonly {
      readonly matchName: string;
      readonly value: unknown;
      readonly expression: string;
    }[];
  }[];
};

class FakeCompItem {
  public readonly layers: FakeLayers;
  public width = 1_920;
  public height = 1_080;
  public duration = 15;
  public frameRate = 30;
  public constructor(
    public readonly id: number,
    public name: string,
    allocateLayerId: () => number,
    seed = false,
  ) {
    this.layers = new FakeLayers(allocateLayerId);
    if (seed) this.layers.seed();
  }
  public get numLayers(): number {
    return this.layers.length;
  }
  public layer(index: number): FakeLayer | undefined {
    return this.layers.layer(index);
  }
}

class FakeShape {
  public vertices: unknown = [];
  public closed = false;
}

const normalized = (value: unknown): Json => JSON.parse(JSON.stringify(value));

export type DispatcherFixture = {
  readonly dispatch: (command: unknown) => AdobeCommandResultV1;
  readonly snapshot: () => Json;
  readonly canonical: () => string;
  readonly sha256: (value: string) => string;
};

export const createDispatcherFixture = (): DispatcherFixture => {
  let nextCompId = 2;
  let nextLayerId = 1;
  const allocateLayerId = (): number => nextLayerId++;
  let compositions = [new FakeCompItem(1, "Main", allocateLayerId, true)];
  const project = {
    file: { name: "working-copy.aep", fullName: "/fixture/working-copy.aep" },
    items: {
      addComp: (
        name: string,
        width: number,
        height: number,
        _pixelAspect: number,
        duration: number,
        frameRate: number,
      ): FakeCompItem => {
        const item = new FakeCompItem(nextCompId++, name, allocateLayerId);
        item.width = width;
        item.height = height;
        item.duration = duration;
        item.frameRate = frameRate;
        compositions.push(item);
        return item;
      },
    },
    get numItems(): number {
      return compositions.length;
    },
    item: (index: number): FakeCompItem | undefined => compositions[index - 1],
    close: (): void => {},
  };
  const saveLayer = (layer: FakeLayer): SavedLayer => ({
    id: layer.id,
    name: layer.name,
    kind: layer.kind,
    source: clone(layer.source),
    properties: [...layer.properties].map(([name, property]) => ({
      name,
      value: clone(property.value),
      expression: property.expression,
      keys: clone(property.keys),
      children: [...property.children].map(([matchName, child]) => ({
        matchName,
        value: clone(child.value),
        expression: child.expression,
      })),
    })),
  });
  type SavedProject = {
    readonly compositions: readonly {
      readonly id: number;
      readonly name: string;
      readonly width: number;
      readonly height: number;
      readonly duration: number;
      readonly frameRate: number;
      readonly layers: readonly SavedLayer[];
    }[];
    readonly nextCompId: number;
    readonly nextLayerId: number;
  };
  let saved: SavedProject | null = null;
  const projectSnapshot = {
    capture: (): void => {
      saved = {
        compositions: compositions.map((item) => ({
          id: item.id,
          name: item.name,
          width: item.width,
          height: item.height,
          duration: item.duration,
          frameRate: item.frameRate,
          layers: item.layers.values.map(saveLayer),
        })),
        nextCompId,
        nextLayerId,
      };
    },
    restore: (): void => {
      if (!saved) throw new Error("missing fixture rollback snapshot");
      compositions = saved.compositions.map((item) => {
        const restored = new FakeCompItem(item.id, item.name, allocateLayerId);
        restored.width = item.width;
        restored.height = item.height;
        restored.duration = item.duration;
        restored.frameRate = item.frameRate;
        restored.layers.restore(item.layers);
        return restored;
      });
      nextCompId = saved.nextCompId;
      nextLayerId = saved.nextLayerId;
    },
  };
  const context: Record<string, unknown> = {
    app: { project },
    CompItem: FakeCompItem,
    Shape: FakeShape,
    CloseOptions: { DO_NOT_SAVE_CHANGES: 0 },
    RVSProjectSnapshot: projectSnapshot,
  };
  context["global"] = context;
  runInNewContext(
    readFileSync(
      new URL("../scripts/extendscript/rvs-dispatcher.jsx", import.meta.url),
      "utf8",
    ),
    context,
  );
  const dispatcher = context["RVSDispatch"];
  const snapshotter = context["RVSProjectReadback"];
  const canonicalizer = context["RVSProjectCanonical"];
  const sha256 = context["RVSSha256"];
  if (
    typeof dispatcher !== "function" ||
    typeof snapshotter !== "function" ||
    typeof canonicalizer !== "function" ||
    typeof sha256 !== "function"
  )
    throw new TypeError("RVS dispatcher/readback was not installed");
  return {
    dispatch: (command) =>
      AdobeCommandResultV1Schema.parse(normalized(dispatcher(command))),
    snapshot: () => normalized(snapshotter()),
    canonical: () => String(canonicalizer()),
    sha256: (value) => String(sha256(value)),
  };
};

export const dispatchFixture = (command: unknown): AdobeCommandResultV1 =>
  createDispatcherFixture().dispatch(command);
