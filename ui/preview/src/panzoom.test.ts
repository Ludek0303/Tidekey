import { describe, expect, it } from "vitest";
import { PanZoom, type Transform } from "./panzoom";

function make(): { pz: PanZoom; last: () => Transform } {
  let last: Transform = { scale: 1, x: 0, y: 0 };
  const pz = new PanZoom((t) => {
    last = t;
  });
  return { pz, last: () => last };
}

describe("PanZoom: dopasowanie", () => {
  it("mały obraz nie jest powiększany i leży na środku", () => {
    const { pz, last } = make();
    pz.fit(800, 600, 100, 50);
    expect(last()).toEqual({ scale: 1, x: 350, y: 275 });
    expect(pz.fitMode).toBe(true);
  });

  it("duży obraz mieści się w widoku, przy zachowaniu proporcji", () => {
    const { pz, last } = make();
    pz.fit(800, 600, 1000, 500);
    expect(last()).toEqual({ scale: 0.8, x: 0, y: 100 });
  });

  it("zmiana rozmiaru w dopasowaniu dopasowuje od nowa", () => {
    const { pz, last } = make();
    pz.fit(800, 600, 1000, 500);
    pz.resize(400, 300);
    expect(last().scale).toBe(0.4);
  });

  it("zmiana rozmiaru po przybliżeniu nie rusza skali", () => {
    const { pz, last } = make();
    pz.fit(800, 600, 1000, 500);
    pz.zoomBy(2);
    pz.resize(400, 300);
    expect(last().scale).toBe(1.6);
    expect(pz.fitMode).toBe(false);
  });
});

describe("PanZoom: przybliżanie", () => {
  it("punkt pod kursorem zostaje w miejscu", () => {
    const { pz, last } = make();
    pz.fit(800, 600, 2000, 1500);
    const before = last();
    const px = 400;
    const py = 300;
    const pointBefore = { x: (px - before.x) / before.scale, y: (py - before.y) / before.scale };
    pz.zoomAt(2, px, py);
    const after = last();
    expect(after.scale).toBeCloseTo(0.8);
    expect((px - after.x) / after.scale).toBeCloseTo(pointBefore.x);
    expect((py - after.y) / after.scale).toBeCloseTo(pointBefore.y);
    expect(pz.fitMode).toBe(false);
  });

  it("skala mieści się w granicach 0,02 do 32", () => {
    const { pz, last } = make();
    pz.fit(800, 600, 2000, 1500);
    pz.zoomAt(1000, 0, 0);
    expect(last().scale).toBe(32);
    pz.zoomAt(1e-9, 0, 0);
    expect(last().scale).toBe(0.02);
  });

  it("dwuklik przełącza dopasowanie i 100 %", () => {
    const { pz, last } = make();
    pz.fit(800, 600, 2000, 1500);
    pz.toggle();
    expect(last().scale).toBe(1);
    expect(pz.fitMode).toBe(false);
    pz.toggle();
    expect(last().scale).toBe(0.4);
    expect(pz.fitMode).toBe(true);
  });
});

describe("PanZoom: przesuwanie", () => {
  it("ogranicza przesunięcie do krawędzi obrazu", () => {
    const { pz, last } = make();
    pz.fit(800, 600, 2000, 1500);
    pz.zoomAt(4, 0, 0);
    expect(last()).toEqual({ scale: 1.6, x: 0, y: 0 });
    pz.panBy(10000, 10000);
    expect(last()).toEqual({ scale: 1.6, x: 0, y: 0 });
    pz.panBy(-100000, -100000);
    expect(last()).toEqual({ scale: 1.6, x: 800 - 3200, y: 600 - 2400 });
  });

  it("obraz węższy niż widok zostaje na środku osi", () => {
    const { pz, last } = make();
    pz.fit(800, 600, 100, 50);
    pz.panBy(500, 500);
    expect(last()).toEqual({ scale: 1, x: 350, y: 275 });
  });
});
