/** Failed forge request; `status` is the HTTP status when known. */
export class ForgeError extends Error {
	public readonly status: number | undefined;

	public constructor(message: string, status?: number, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
		this.status = status;
	}
}

/** The PR or release to create exists. */
export class ForgeConflictError extends ForgeError {}

/** The requested resource does not exist. */
export class ForgeNotFoundError extends ForgeError {}
