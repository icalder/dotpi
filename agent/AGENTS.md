# Specific Instructions

## Coding

### Tools

GitHub cli `gh` is available. Use it for any GitHub search or fetch requirements.

#### Rust

Always use the cratesio-mcp tool to search and retrieve Rust docs for any crate on crates.io. The tool can also return version and dependenc information for any crate.

### Software Standards

These are important.

#### SOLID Principles

Apply these five architectural constraints to all generated code to ensure maintainability, scalability, and ease of testing.

1. Single Responsibility Principle (SRP) - the most important rule of all!!!
> **Rule:** A class or module must have one, and only one, reason to change.
*   **Action:** Separate business logic, data access, and presentation. If a class manages both data validation and database persistence, split it into two distinct classes.

2. Open/Closed Principle (OCP)
> **Rule:** Software entities should be open for extension, but closed for modification.
*   **Action:** Do not hardcode conditionals (`if/switch`) to handle new features or behaviors. Instead, use polymorphism, interfaces, or abstract classes so new behavior can be added by writing new classes, not modifying existing code.

3. Liskov Substitution Principle (LSP)
> **Rule:** Subtypes must be completely substitutable for their base types without altering correctness.
*   **Action:** Derived classes must honor the contract of the parent class. Do not throw `UnsupportedOperationException` in inherited methods, and do not weaken preconditions or strengthen postconditions.

4. Interface Segregation Principle (ISP)
> **Rule:** Clients should not be forced to depend on methods they do not use.
*   **Action:** Favor small, role-focused interfaces over large, "fat" interfaces. Split multi-purpose interfaces into smaller chunks (e.g., break `WorkerInterface` into `Runnable` and `Deletable`).

5. Dependency Inversion Principle (DIP)
> **Rule:** Depend on abstractions (interfaces), not concretions (concrete classes).
*   **Action:** High-level modules must not import low-level modules directly. Use Dependency Injection (DI) to pass dependencies into constructors, allowing implementations to be easily swapped or mocked in tests.

#### Clean Code reminder (Robert C. Martin, 2008)
- **Functions**: small, do one thing, one level of abstraction (G34), ≤3 args (F1), no boolean flag args (F3), no output args (F2).
- **Names**: reveal intent (N1), unambiguous (N4), longer for longer scopes (N5), describe side effects (N7).
- **Comments**: explain *why* not *what*; delete obsolete (C2), redundant (C3), commented-out (C5).
- **General**: duplication is the worst smell (G5); polymorphism over switch (G23); encapsulate conditionals (G28); avoid Law-of-Demeter violations (G36); replace magic numbers with named constants (G25).
- **Tests**: F.I.R.S.T. — Fast, Independent, Repeatable, Self-validating, Timely; test boundary conditions (T5).

#### Gang of Four reminder (Gamma/Helm/Johnson/Vlissides, 1994)
- **23 patterns** in three groups:
  - **Creational**: Abstract Factory, Builder, Factory Method, Prototype, Singleton.
  - **Structural**: Adapter, Bridge, Composite, Decorator, Facade, Flyweight, Proxy.
  - **Behavioral**: Chain of Responsibility, Command, Interpreter, Iterator, Mediator, Memento, Observer, State, Strategy, Template Method, Visitor.

#### General
- **Two core rules**: *program to an interface, not an implementation*; *favor object composition over class inheritance*.



