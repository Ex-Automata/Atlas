"use strict";

(function () {
    const registry = window.AtlasAnnotations;
    if (!registry || typeof registry.register !== "function") return;

    registry.register({
        id: "folding_ranges",
        process(dataset, api) {
            if (!dataset || typeof dataset !== "object") return;
            
            // Dataset structure: { [uri]: { [annotationId]: { id, ranges, ... } } }
            for (const uri in dataset) {
                const annotations = dataset[uri];
                if (!annotations || typeof annotations !== "object") continue;
                
                for (const annotationId in annotations) {
                    const annotation = annotations[annotationId];
                    if (!annotation || !annotation.ranges) continue;
                    
                    // Add all ranges for this annotation with markWholeLine option
                    for (const range of annotation.ranges) {
                        api.addRange(uri, range, { markWholeLine: true });
                    }
                }
            }
        },
    });
})();
