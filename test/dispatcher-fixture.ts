import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

class FakeProperty {
  public expression = "";
  public name = "Drop Shadow";
  public setValue(_value: unknown): void {}
  public setValueAtTime(_time: number, _value: unknown): void {}
  public addProperty(_name: string): FakeProperty {
    return new FakeProperty();
  }
  public property(_name: string): FakeProperty {
    return new FakeProperty();
  }
}

class FakeLayer {
  public constructor(
    public readonly id: number,
    public name: string,
  ) {}
  public property(_name: string): FakeProperty {
    return new FakeProperty();
  }
  public duplicate(): FakeLayer {
    return new FakeLayer(2, `${this.name} copy`);
  }
  public remove(): void {}
}

class FakeLayers {
  readonly #base = new FakeLayer(1, "Title");
  public addText(_text: string): FakeLayer {
    return new FakeLayer(2, "Text");
  }
  public addSolid(_color: unknown, name: string): FakeLayer {
    return new FakeLayer(2, name);
  }
  public addCamera(name: string): FakeLayer {
    return new FakeLayer(2, name);
  }
  public addNull(): FakeLayer {
    return new FakeLayer(2, "Null");
  }
  public addShape(): FakeLayer {
    return new FakeLayer(2, "Shape");
  }
  public get length(): number {
    return 1;
  }
  public layer(index: number): FakeLayer | undefined {
    return index === 1 ? this.#base : undefined;
  }
}

class FakeCompItem {
  public readonly layers = new FakeLayers();
  public width = 1_920;
  public height = 1_080;
  public duration = 15;
  public frameRate = 30;
  public constructor(
    public readonly id: number,
    public name: string,
  ) {}
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

export const dispatchFixture = (command: unknown): unknown => {
  const base = new FakeCompItem(1, "Main");
  const items = {
    addComp: (name: string): FakeCompItem => new FakeCompItem(2, name),
  };
  const project = {
    file: { name: "working-copy.aep" },
    items,
    get numItems(): number {
      return 1;
    },
    item: (index: number): FakeCompItem | undefined =>
      index === 1 ? base : undefined,
    close: (): void => {},
  };
  const context: Record<string, unknown> = {
    app: { project },
    CompItem: FakeCompItem,
    Shape: FakeShape,
    CloseOptions: { DO_NOT_SAVE_CHANGES: 0 },
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
  if (typeof dispatcher !== "function")
    throw new TypeError("RVSDispatch was not installed");
  return dispatcher(command);
};
