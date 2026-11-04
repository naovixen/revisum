// The accessible roles a role locator may name.
export const Role = {
    Alert: "alert",
    Button: "button",
    Checkbox: "checkbox",
    Combobox: "combobox",
    Dialog: "dialog",
    Heading: "heading",
    Image: "img",
    Link: "link",
    ListItem: "listitem",
    Main: "main",
    Navigation: "navigation",
    Option: "option",
    Radio: "radio",
    Region: "region",
    SearchBox: "searchbox",
    Status: "status",
    Switch: "switch",
    Tab: "tab",
    TextBox: "textbox",
    ListBox: "listbox",
    MenuItem: "menuitem",
    Table: "table",
    Row: "row",
    Cell: "cell",
    Form: "form",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const ROLES: readonly Role[] = Object.values(Role);
