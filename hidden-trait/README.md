# hidden-trait
[![Build Status](https://github.com/kvark/hidden-trait/workflows/check/badge.svg)](https://github.com/kvark/hidden-trait/actions)
[![Docs](https://docs.rs/hidden-trait/badge.svg)](https://docs.rs/hidden-trait)
[![Crates.io](https://img.shields.io/crates/v/hidden-trait.svg?maxAge=2592000)](https://crates.io/crates/hidden-trait)

This library is a proc macro to expose a trait implementation.

The case we are trying to solve here: a library exposes some concrete structure for people to use. There can be multiple of them (e.g. `Vector2`, `Vector3`, `Vector4` in a math library), or maybe it's one per platform (Vulkan vs Metal). Important part is - internally the library would like to have a trait implemented by this public type, but it doesn't want to expose the trait itself because of ergonomic reasons. Hence, "hidden-trait" to rescue.

```rust
mod hidden {
    trait Foo {
        fn foo(&self) -> u32;
    }

    pub struct Bar;

    #[hidden_trait::expose]
    impl Foo for Bar {
        fn foo(&self) -> u32 {
            42
        }
    }
}

fn main() {
    let bar = hidden::Bar;
    // calling the trait method as if it's ours
    bar.foo();
}
```