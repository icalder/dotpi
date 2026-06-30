---
name: train-profile-generator
description: Generate or modify linear control assignments for Train Sim World 6 controller profile JSON files. Supports separate throttle/brake levers and combined power-and-brake handles. Can create new profiles from scratch.
---

# Train Profile Generator Skill

Generate, create, or update controller profile JSON files for Train Sim World 6.
Supports creating profiles from scratch and assigning throttle/brake controls (usually joystick axes) via linear, direct, or API mapping.

## Schema Reference

The full JSON schemas are available in the tsw-controller-app repo:
- Main schema: `https://github.com/LiahMartens/tsw-controller-app/blob/main/profile-builder-schema/profile.schema.json`
- All schemas: `https://github.com/LiahMartens/tsw-controller-app/tree/main/profile-builder-schema`

Use `gh` to fetch the latest if you're unsure whether the schema has changed:
```
gh api repos/LiahMartens/tsw-controller-app/repos/contents/profile-builder-schema/profile.schema.json -q '.content' | base64 -d
```

## Profile Schema (minimal required)

A valid profile needs only `name` and `controls`:

```json
{
  "name": "Profile Name",
  "controls": [
    {
      "name": "Control Name (as calibrated by the app)",
      "assignments": [ ... ]
    }
  ]
}
```

Optional top-level fields:
- `extends`: another profile name to inherit controls from
- `auto_select`: boolean for auto-detection (see **Auto Selection** below)
- `controller`: object with `usb_id`, `mapping`, `calibration`
- `rail_class_information`: array of `{ "class_name": "..." }`
- `listeners`: reactive listeners (advanced, not needed for basic profiles)

## Auto Selection

Auto selection lets the app automatically pick the right profile when a specific train is loaded, without manual selection. Requires three fields:

```json
{
  "name": "Train Name",
  "auto_select": true,
  "rail_class_information": [
    { "class_name": "RVM_..." }
  ],
  "controller": {
    "usb_id": "VVVV:PPPP"
  },
  "controls": [ ... ]
}
```

### Finding the USB ID
- In the TSW Controller App: check the controller settings/calibration screen
- Linux: `lsusb` (e.g. `16D0:0DA2` for TQ6)
- Windows: Device Manager → Properties → Hardware Ids
- Format: `"VVVV:PPPP"` (hex, lowercase)

### Finding the Rail Class Name
1. Load the train in TSW
2. Open the **Cab Debugger** in the TSW Controller App
3. The **class name** is shown at the top (e.g. `RVM_GWR_Class150_DMSL_C`)
4. Copy it exactly — it's case-sensitive

A profile can match multiple class names (e.g. different liveries of the same train):
```json
"rail_class_information": [
  { "class_name": "RVM_GWR_Class150_DMSL_C" },
  { "class_name": "RVM_SC_Class150_DMSL_C" }
]
```

Each control in `controls[]` **must** have `name` and `assignments`.
A `description` field may appear on either the **control** or the **assignment** — both patterns are valid and used by existing profiles.

## Assignment Types

### `linear` — Notched lever with thresholds (most common for throttle/brake)

Acts like a customized lever, triggering actions at specific input positions.

```json
{
  "type": "linear",
  "thresholds": [
    {
      "value": 0.0,
      "action_activate": { "controls": "Throttle_IrregularLever", "value": 0.0 },
      "action_deactivate": { "controls": "Throttle_IrregularLever", "value": 0.0 }
    }
  ]
}
```

Optional: `neutral` (number) — maps the 0-1 input range to -1..1.

Each threshold requires `value` and `action_activate`. `action_deactivate` is optional.

### `direct_control` — Continuous axis passthrough

Maps a joystick axis directly onto a cab lever with no notching.

```json
{
  "type": "direct_control",
  "controls": "Throttle_IrregularLever",
  "input_value": {
    "min": 0,
    "max": 1
  }
}
```

Required: `controls`, `input_value` (with `min` and `max`).
Optional on assignment: `hold`, `use_normalized`, `enable_api_fallback`, `notify`, `control_range`.
Optional on `input_value`: `max_change_rate`, `step`, `steps`, `invert`, `step_thresholds`.

### `api_control` — Continuous axis via HTTP API

Same as `direct_control` but routes through the TSW HTTP API (slight overhead, broader compatibility).

```json
{
  "type": "api_control",
  "controls": "Throttle_IrregularLever",
  "input_value": { "min": 0, "max": 1 }
}
```

### `momentary` — Button press (hold to activate)

```json
{
  "type": "momentary",
  "threshold": 0.5,
  "action_activate": { "controls": "Horn", "value": 1 },
  "action_deactivate": { "controls": "Horn", "value": 0 }
}
```

### `toggle` — Button press (toggle on/off)

```json
{
  "type": "toggle",
  "threshold": 0.5,
  "action_activate": { "controls": "HeadcodeLights", "value": 1 },
  "action_deactivate": { "controls": "HeadcodeLights", "value": 0 }
}
```

### Action types inside `action_activate` / `action_deactivate`

| Type | Fields | Description |
|------|--------|-------------|
| **Direct control** | `controls`, `value` | Send value to cab directly. Optional: `hold`, `max_change_rate`, `relative`, `use_normalized`, `notify`, `enable_api_fallback` |
| **API control** | `controls`, `api_value` | Send value via HTTP API. Optional: `hold`, `max_change_rate` |
| **Keys** | `keys` | Simulate keystrokes (e.g. `"q+pagedown"`). Optional: `press_time`, `wait_time` |
| **Virtual** | `type: "virtual"`, `control` (prefix `virtual:`), `value` | Update a virtual control |

## Creating a New Profile From Scratch

When the user asks to create a new profile:

1. **Ask for the profile name** (e.g. "Class 313").
2. **Ask for each control** — the calibrated control name from the app (e.g. "Axis 0", "Axis 5") and what it should map to.
3. **For each control**, determine the assignment type and parameters:
   - **Linear (notched)**: how many positions? throttle or brake? control name? end stop?
   - **Direct/API (continuous)**: control name? min/max? invert?
4. **Build the JSON** with the proper structure.
5. **Write the file** as `<profile-name>-<control>_timestamp.json` in the profiles directory.
6. **Confirm** and show a summary.

### Profile scaffolding template

```json
{
  "name": "<Profile Name>",
  "controls": [
    {
      "name": "<Control Name>",
      "assignments": [
        {
          "type": "<assignment_type>",
          ...
        }
      ]
    }
  ]
}
```

## Linear Threshold Generation Rules

Apply these rules when generating `linear` assignment thresholds.

### 1. Separate Throttle (forward mapping)

**Parameters**: `positions` (N), `endStop` (default 0.95), `controlName` (e.g. `Throttle_IrregularLever`)

- Input `value[i] = endStop * i / (N-1)` for i = 0..N-1
- Output `action_activate.value[i] = value[i]` (same direction)
- Output `action_deactivate.value[i] = action_activate.value[i-1]` (previous notch, or 0 for i=0)

**Example**: 8 positions, endStop=0.95
| i | value | activate | deactivate |
|---|-------|----------|------------|
| 0 | 0.0000 | 0.0000 | 0.0000 |
| 1 | 0.1357 | 0.1357 | 0.0000 |
| 2 | 0.2714 | 0.2714 | 0.1357 |
| ... | ... | ... | ... |
| 7 | 0.9500 | 0.9500 | 0.8143 |

### 2. Separate Brake (reverse mapping)

**Parameters**: `positions` (N), `endStop` (default 0.95), `controlName` (e.g. `TrainBrake_IrregularLever`)

- Input `value[i] = endStop * i / (N-1)` for i = 0..N-1
- Output `action_activate.value[i] = endStop - value[i]` (opposite direction)
- Output `action_deactivate.value[i] = action_activate.value[i-1]` (previous notch, or endStop for i=0)

**Example**: 5 positions, endStop=0.95
| i | value | activate | deactivate |
|---|-------|----------|------------|
| 0 | 0.0000 | 0.9500 | 0.9500 |
| 1 | 0.2375 | 0.7125 | 0.9500 |
| 2 | 0.4750 | 0.4750 | 0.7125 |
| 3 | 0.7125 | 0.2375 | 0.4750 |
| 4 | 0.9500 | 0.0000 | 0.2375 |

### 3. Combined Power-and-Brake Handle

**Parameters**: `brakePositions` (B), `powerPositions` (P), `endStop` (default 0.95), `controlName` (e.g. `PowerHandle(IrregularLever)`)

The lever spans: full brake → neutral → full power.

Total notches = B + 1 (neutral) + P. Total segments = B + P.

- Input `value[i] = endStop * i / (B + P)` for i = 0..(B+P)
- Output ranges from `-endStop` (full brake) to `+endStop` (full power)
- Output `action_deactivate.value[i] = action_activate.value[i-1]` (or first value for i=0)

Output formula:
- Brake side (i = 0..B): `action_activate.value[i] = endStop * (i/B - 1)` → ranges from `-endStop` to `0`
- Power side (i = B..B+P): `action_activate.value[i] = endStop * (i - B) / P` → ranges from `0` to `+endStop`
- At i = B (neutral), both formulas yield 0.

**Example**: 4 brake + 4 power (B=4, P=4), endStop=0.95
| i | value | activate | deactivate | Meaning |
|---|-------|----------|------------|---------|
| 0 | 0.0000 | -0.9500 | -0.9500 | Full brake |
| 1 | 0.1188 | -0.7125 | -0.9500 | |
| 2 | 0.2375 | -0.4750 | -0.7125 | |
| 3 | 0.3563 | -0.2375 | -0.4750 | |
| 4 | 0.4750 | 0.0000 | -0.2375 | Neutral |
| 5 | 0.5938 | 0.2375 | 0.0000 | |
| 6 | 0.7125 | 0.4750 | 0.2375 | |
| 7 | 0.8313 | 0.7125 | 0.4750 | |
| 8 | 0.9500 | 0.9500 | 0.7125 | Full power |

## Existing Profile Variants

When **modifying** an existing file, detect which variant it uses:

### Variant A — Separate Controls (e.g. Class 150)
Each control (throttle, brake) is a separate object in `controls[]`. The `description` lives on the **assignment**:
```json
{
  "name": "Train Name",
  "controls": [
    {
      "name": "throttle",
      "assignments": [{ "type": "linear", "thresholds": [...], "description": "Throttle" }]
    },
    {
      "name": "brake",
      "assignments": [{ "type": "linear", "thresholds": [...], "description": "Brake" }]
    }
  ]
}
```

### Variant B — Single Combined Control (e.g. GWR 802)
One control object, `description` on the **control** itself:
```json
{
  "name": "Train Name",
  "controls": [
    {
      "name": "throttle",
      "assignments": [{ "type": "linear", "thresholds": [...] }],
      "description": "Power and Brake Handle"
    }
  ]
}
```

## Common Control Names

| Type | Example Names |
|------|--------------|
| Throttle | `Throttle_IrregularLever`, `Throttle(Lever)` |
| Brake | `TrainBrake_IrregularLever`, `TrainBrake(Lever)` |
| Combined | `PowerHandle(IrregularLever)`, `PowerAndBrake_IrregularLever` |
| Other | `MasterController`, `Horn`, `AutomaticBrake_{SIDE}`, `IndependentBrake_{SIDE}` |

## Rounding

Round all computed values to 4 decimal places.

## Instructions

### Creating a new profile from scratch
1. **Gather** the profile name, control names (as calibrated), and mapping requirements.
2. **Choose** the assignment type (`linear`, `direct_control`, `api_control`) for each control.
3. **Compute** threshold values (for `linear`) or configure input ranges (for `direct_control`/`api_control`).
4. **Build** the complete JSON profile.
5. **Write** the file to the profiles directory with a descriptive name.
6. **Confirm** the parameters used and show a summary table.

### Modifying an existing profile
1. **Read** the existing profile file to determine the variant structure and control names.
2. **Compute** threshold values using the formulas above.
3. **Generate** the JSON thresholds array with proper structure.
4. **Replace** the existing thresholds in-place using exact text replacement, preserving all other file content (name, description placement, etc.).
5. **Confirm** the parameters used and show a summary table of positions.

## Typical User Requests

- "Create a new profile for Class 313 with throttle on Axis 0 and brake on Axis 5"
- "Generate a throttle with X positions"
- "Add a brake lever with Y positions, reversed"
- "Make a combined power-and-brake with B brake and P power notches"
- "Map this axis directly to the throttle (continuous, no notches)"
- "Change the end stop to 0.95"
- "Update this profile to use linear spacing"
