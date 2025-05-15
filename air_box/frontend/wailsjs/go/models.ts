export namespace main {
	
	export class PM25Data {
	    timestamp: number;
	    value: number;
	
	    static createFrom(source: any = {}) {
	        return new PM25Data(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.timestamp = source["timestamp"];
	        this.value = source["value"];
	    }
	}

}

