//! Bridge affine_doc_loader 0.1.7's simple tables to BlockSuite's editable schema.
//! Keep this at the native write boundary so every Markdown writer benefits.
use y_octo::{Any, Doc, Value};

/// Apply the writer delta, repair only legacy table fields, and return a delta
/// relative to the original document. Existing Y.Text cells are never replaced.
pub(crate) fn editable_tables(existing: Option<&[u8]>, update: &[u8]) -> anyhow::Result<Vec<u8>> {
  let mut doc = Doc::default();
  if let Some(existing) = existing {
    doc.apply_update_from_binary_v1(existing)?;
  }
  let before = doc.get_state_vector();
  doc.apply_update_from_binary_v1(update)?;
  let blocks = doc.get_map("blocks")?;
  for value in blocks.values() {
    let Some(mut block) = value.to_map() else { continue };
    if block.get("sys:flavour") != Some(Value::Any(Any::String("affine:table".into()))) {
      continue;
    }
    // Collect before changing the map, preserving cell/row/column IDs.
    let entries = block.entries().map(|(k, v)| (k.to_string(), v)).collect::<Vec<_>>();
    for (key, value) in entries {
      let Value::Any(Any::String(value)) = value else {
        continue;
      };
      if key.starts_with("prop:cells.") && key.ends_with(".text") {
        let mut text = doc.create_text()?;
        block.insert(key, Value::Text(text.clone()))?;
        text.insert(0, value)?;
      } else if (key.starts_with("prop:rows.") || key.starts_with("prop:columns."))
        && key.ends_with(".order")
        && value.len() >= 6
        && value.bytes().all(|b| b.is_ascii_digit())
      {
        // The loader emits zero-padded decimal numbers. BlockSuite inserts
        // between keys using fractional-indexing, whose integer head is a letter.
        let mut index: u64 = value.parse()?;
        let alphabet = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
        let mut digits = [b'0'; 6];
        for digit in digits.iter_mut().rev() {
          *digit = alphabet[(index % 62) as usize];
          index /= 62;
        }
        anyhow::ensure!(index == 0, "table order exceeds supported range");
        let order = format!("f{}", std::str::from_utf8(&digits)?);
        block.insert(key, Any::String(order))?;
      }
    }
  }
  Ok(doc.encode_state_as_update_v1(&before)?)
}
