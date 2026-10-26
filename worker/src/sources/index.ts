import { censusSource } from "./census";
import { crimeSource } from "./crime";
import { epcSource } from "./epc";
import { floodSource } from "./flood";
import { planningSource } from "./planning";
import { postcodesSource } from "./postcodes";
import { pricePaidSource } from "./pricePaid";
import { servicesSource } from "./services";
import type { SourceDef } from "./types";

/** postcode must stay first: it supplies the coordinates and LSOA the others need. */
export const SOURCES: SourceDef[] = [postcodesSource, crimeSource, pricePaidSource, epcSource, floodSource, planningSource, censusSource, servicesSource];

export const SOURCE_META = SOURCES.map((s) => ({ id: s.id, label: s.label, attribution: s.attribution }));
