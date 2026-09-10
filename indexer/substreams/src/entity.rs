//! A small builder for `sf.substreams.sink.entity.v1.EntityChanges`, the format graph-node reads
//! from a Substreams-powered subgraph. Values follow graph-node's conventions: `BigInt` as a
//! decimal string, `Bytes` as base64, arrays as arrays.
use crate::pb::sf::substreams::sink::entity::v1::{entity_change::Operation, value::Typed, Array, EntityChange, EntityChanges, Field, Value};

pub struct Row {
    change: EntityChange,
}

impl Row {
    fn new(entity: &str, id: &str, operation: Operation, ordinal: u64) -> Self {
        Row {
            change: EntityChange {
                entity: entity.to_string(),
                id: id.to_string(),
                ordinal,
                operation: operation as i32,
                fields: vec![],
            },
        }
    }

    fn push(&mut self, name: &str, typed: Typed) -> &mut Self {
        self.change.fields.push(Field { name: name.to_string(), new_value: Some(Value { typed: Some(typed) }), old_value: None });
        self
    }

    pub fn string(&mut self, name: &str, v: &str) -> &mut Self {
        self.push(name, Typed::String(v.to_string()))
    }

    pub fn bigint(&mut self, name: &str, v: impl ToString) -> &mut Self {
        self.push(name, Typed::Bigint(v.to_string()))
    }

    pub fn int(&mut self, name: &str, v: i32) -> &mut Self {
        self.push(name, Typed::Int32(v))
    }

    pub fn boolean(&mut self, name: &str, v: bool) -> &mut Self {
        self.push(name, Typed::Bool(v))
    }

    /// A `Bytes` field from raw bytes.
    pub fn bytes(&mut self, name: &str, v: &[u8]) -> &mut Self {
        self.push(name, Typed::Bytes(base64_encode(v)))
    }

    /// A `Bytes` field from a base58 string (Solana pubkey or signature). Non-base58 input is
    /// stored as UTF-8 bytes so nothing is dropped.
    pub fn bytes_b58(&mut self, name: &str, v: &str) -> &mut Self {
        let raw = bs58::decode(v).into_vec().unwrap_or_else(|_| v.as_bytes().to_vec());
        self.bytes(name, &raw)
    }

    /// A `Bytes` field from a 0x-hex string.
    pub fn bytes_hex(&mut self, name: &str, v: &str) -> &mut Self {
        let raw = hex::decode(v.trim_start_matches("0x")).unwrap_or_else(|_| v.as_bytes().to_vec());
        self.bytes(name, &raw)
    }

    /// `[Bytes!]!` from 0x-hex strings.
    pub fn bytes_hex_array(&mut self, name: &str, v: &[String]) -> &mut Self {
        let values = v
            .iter()
            .map(|s| Value { typed: Some(Typed::Bytes(base64_encode(&hex::decode(s.trim_start_matches("0x")).unwrap_or_default()))) })
            .collect();
        self.push(name, Typed::Array(Array { value: values }))
    }
}

#[derive(Default)]
pub struct Changes {
    rows: Vec<Row>,
    ordinal: u64,
}

impl Changes {
    pub fn new() -> Self {
        Self::default()
    }

    fn row(&mut self, entity: &str, id: &str, op: Operation) -> &mut Row {
        self.ordinal += 1;
        self.rows.push(Row::new(entity, id, op, self.ordinal));
        self.rows.last_mut().unwrap()
    }

    pub fn create(&mut self, entity: &str, id: &str) -> &mut Row {
        self.row(entity, id, Operation::Create)
    }

    pub fn update(&mut self, entity: &str, id: &str) -> &mut Row {
        self.row(entity, id, Operation::Update)
    }

    pub fn delete(&mut self, entity: &str, id: &str) {
        self.row(entity, id, Operation::Delete);
    }

    pub fn finish(self) -> EntityChanges {
        EntityChanges { entity_changes: self.rows.into_iter().map(|r| r.change).collect() }
    }
}

/// Standard base64 (RFC 4648) without pulling a crate in for one function.
pub fn base64_encode(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn rows_carry_typed_fields_and_operations() {
        let mut c = Changes::new();
        c.create("Action", "sig:0").string("chain", "solana").bigint("amount", 42u64).boolean("allowed", false).int("errorCode", 6007).bytes_hex("ensNode", "0x0102");
        c.delete("Permission", "p");
        let out = c.finish();
        assert_eq!(out.entity_changes.len(), 2);
        let a = &out.entity_changes[0];
        assert_eq!(a.entity, "Action");
        assert_eq!(a.operation, Operation::Create as i32);
        assert_eq!(a.fields.len(), 5);
        assert!(matches!(a.fields[1].new_value.as_ref().unwrap().typed, Some(Typed::Bigint(ref s)) if s == "42"));
        assert!(matches!(a.fields[4].new_value.as_ref().unwrap().typed, Some(Typed::Bytes(ref s)) if s == "AQI="));
        assert_eq!(out.entity_changes[1].operation, Operation::Delete as i32);
        assert_eq!(out.entity_changes[1].ordinal, 2);
    }
}
