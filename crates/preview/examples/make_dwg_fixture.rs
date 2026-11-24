//! Writes `fixtures/preview/rysunek.dwg`: a small floor plan that the DWG tests read back.
//! Run from the repository root: `cargo run -p notes-preview --example make_dwg_fixture`.

use std::error::Error;
use std::path::Path;

use acadrust::entities::{Arc, Circle, EntityType, Line, LwPolyline, Text};
use acadrust::tables::Layer;
use acadrust::types::{Color, Vector2, Vector3};
use acadrust::{CadDocument, DwgWriter};

fn on_layer(mut entity: EntityType, layer: &str) -> EntityType {
    let common = match &mut entity {
        EntityType::Line(e) => &mut e.common,
        EntityType::Circle(e) => &mut e.common,
        EntityType::Arc(e) => &mut e.common,
        EntityType::LwPolyline(e) => &mut e.common,
        EntityType::Text(e) => &mut e.common,
        _ => return entity,
    };
    common.layer = layer.to_string();
    entity
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut doc = CadDocument::new();
    for (name, index) in [("Ściany", 1), ("Okna i drzwi", 3), ("Opisy", 5)] {
        doc.layers.add(Layer::with_color(name, Color::from_index(index)))?;
    }

    // Walls: a 6 m x 4 m room with its outline as four lines.
    let corners = [(0.0, 0.0), (6000.0, 0.0), (6000.0, 4000.0), (0.0, 4000.0)];
    for i in 0..corners.len() {
        let (x1, y1) = corners[i];
        let (x2, y2) = corners[(i + 1) % corners.len()];
        let line = Line::from_coords(x1, y1, 0.0, x2, y2, 0.0);
        doc.add_entity(on_layer(EntityType::Line(line), "Ściany"))?;
    }
    // A door opening as an arc, a column as a circle, a bay as a closed polyline.
    let door = Arc::from_coords(3000.0, 0.0, 0.0, 900.0, 0.0, std::f64::consts::FRAC_PI_2);
    doc.add_entity(on_layer(EntityType::Arc(door), "Okna i drzwi"))?;
    let column = Circle::from_coords(1500.0, 2000.0, 0.0, 250.0);
    doc.add_entity(on_layer(EntityType::Circle(column), "Ściany"))?;
    let mut bay = LwPolyline::from_points(vec![
        Vector2::new(4000.0, 1000.0),
        Vector2::new(5500.0, 1000.0),
        Vector2::new(5500.0, 3000.0),
        Vector2::new(4000.0, 3000.0),
    ]);
    bay.is_closed = true;
    doc.add_entity(on_layer(EntityType::LwPolyline(bay), "Okna i drzwi"))?;

    let title = Text::with_value("Rzut parteru", Vector3::new(0.0, -800.0, 0.0)).with_height(300.0);
    doc.add_entity(on_layer(EntityType::Text(title), "Opisy"))?;
    let label = Text::with_value("Pokój: łódź, żółw, zażółć gęślą jaźń", Vector3::new(0.0, -1400.0, 0.0))
        .with_height(250.0);
    doc.add_entity(on_layer(EntityType::Text(label), "Opisy"))?;

    let bytes = DwgWriter::write_to_vec(&doc)?;
    let target = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/preview/rysunek.dwg");
    std::fs::write(&target, &bytes)?;
    println!("{} ({} B)", target.display(), bytes.len());
    Ok(())
}
