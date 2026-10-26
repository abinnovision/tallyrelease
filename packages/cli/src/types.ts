/** True only for identical types, including optional fields. */
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters -- identity check */
export type Equals<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */

/** Keys of every member of a union. */
export type Keys<T> = T extends unknown ? keyof T : never;
