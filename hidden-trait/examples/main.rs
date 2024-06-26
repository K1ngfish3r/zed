mod hidden {
    trait Foo {
        type Goal;
        const GOAL: Self::Goal;
        fn foo(&self, other: bool) -> u32;
    }

    pub struct Bar;

    #[hidden_trait::expose]
    impl Foo for Bar {
        type Goal = f32;
        const GOAL: f32 = 1.0;
        fn foo(&self, _other: bool) -> u32 {
            42
        }
    }
}

fn main() {
    let bar = hidden::Bar;
    // calling the trait method as if it's ours
    bar.foo(false);
    let _ = hidden::Bar::GOAL;
}
