import { ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-shadow" d="M12 8H4V4H12ZM12 20H4V12H12Z" fill="var(--icon-weak-base)" />
      <path data-slot="logo-logo-mark-a" d="M0 0H16V20H0ZM12 4H4V8H12ZM12 12H4V20H12Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M60 40H20V20H60ZM60 100H20V60H60Z" fill="var(--icon-base)" />
      <path d="M0 0H80V100H0ZM60 20H20V40H60ZM60 60H20V100H60Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 288 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g>
        {/* T */}
        <path d="M0 6H24V12H18V36H6V12H0Z" fill="var(--icon-base)" />
        {/* h */}
        <path d="M48 36H36V18H48Z" fill="var(--icon-weak-base)" />
        <path d="M30 6H36V18H54V36H48V24H36V36H30Z" fill="var(--icon-base)" />
        {/* e */}
        <path d="M84 24V30H66V24H84Z" fill="var(--icon-weak-base)" />
        <path d="M84 24H66V30H84V36H60V6H84V24ZM66 18H78V12H66V18Z" fill="var(--icon-base)" />
        {/* S */}
        <path d="M114 18H96V12H114ZM108 30H90V24H108Z" fill="var(--icon-weak-base)" />
        <path d="M90 6H114V36H90ZM114 12H96V18H114ZM108 24H90V30H108Z" fill="var(--icon-base)" />
        {/* m */}
        <path d="M132 36H126V12H132ZM144 36H138V12H144Z" fill="var(--icon-weak-base)" />
        <path d="M120 6H150V36H120ZM132 12H126V36H132ZM144 12H138V36H144Z" fill="var(--icon-base)" />
        {/* a */}
        <path d="M174 18H162V12H174ZM174 36H162V24H174Z" fill="var(--icon-weak-base)" />
        <path d="M156 6H180V36H156ZM174 12H162V18H174ZM174 24H162V36H174Z" fill="var(--icon-base)" />
        {/* r */}
        <path d="M204 18H192V12H204Z" fill="var(--icon-weak-base)" />
        <path d="M186 6H210V24H198V30H192V36H186ZM204 12H192V18H204ZM204 30H210V36H204Z" fill="var(--icon-base)" />
        {/* t */}
        <path d="M216 6H240V12H234V36H222V12H216Z" fill="var(--icon-base)" />
        {/* A */}
        <path d="M264 18H252V12H264ZM264 36H252V24H264Z" fill="var(--icon-weak-base)" />
        <path d="M246 6H270V36H246ZM264 12H252V18H264ZM264 24H252V36H264Z" fill="var(--icon-strong-base)" />
        {/* I */}
        <path d="M276 6H288V36H276Z" fill="var(--icon-strong-base)" />
      </g>
    </svg>
  )
}
