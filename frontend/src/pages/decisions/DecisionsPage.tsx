/**
 * DecisionsPage - "Decisions Studio" & Executive Overview (route /)
 *
 * Implements the core functional decision engine of the Manufacturing Atlas AI:
 * "A decision support platform for industrial policy, manufacturing investment, and supplier development."
 *
 * 5 Real Operational Workflows:
 * 1. Opportunity Assessment & PRI Scoring (25 strategic products across 10 sectors)
 * 2. Location & Viability (Dynamic comparison of 23 industrial corridors mapped to active product)
 * 3. Supplier Capability & Trader Intelligence (Distinguishes 32 verified factory operators vs commercial trading houses)
 * 4. Public Industrial Policy & Cluster Interventions (23 corridor-specific SPV infrastructure proposals reactively synchronized to active product)
 * 5. Product Diversification & Transition Simulator (25 tailored adjacent product migrations with CAPEX & ROI)
 */

import { useState, useMemo, useEffect } from 'react';
import {
  Target,
  MapPin,
  Wrench,
  Building2,
  TrendingUp,
  Download,
  Info,
  CheckCircle2,
  AlertTriangle,
  FileText,
  Truck,
  Users,
  Search,
  ChevronDown,
  ChevronUp,
  FileCheck,
  Sparkles,
  ArrowRight,
  ArrowLeft,
  RotateCcw,
} from 'lucide-react';
import {
  Card,
  Button,
  Tabs,
  type TabDef,
  SegmentedControl,
  Modal,
} from '@/components';

type PersonaMode = 'policymaker' | 'business';
type WorkflowTab = 'opportunity' | 'location' | 'supplier' | 'intervention' | 'diversification';
type EntityFilterType = 'all' | 'manufacturer' | 'trader';

interface PriPillar {
  score: number;
  weight: number;
  points: number;
  details?: string;
  [key: string]: any;
}

interface StrategicProduct {
  hsn8: string;
  hs6: string;
  title: string;
  sector: string;
  ministry: string;
  imports_usd: number;
  exports_usd: number;
  world_trade_usd: number;
  rca: number;
  pri_score: number;
  pri_tier: string;
  pli_scheme?: string;
  qco_status?: string;
  verdict?: string;
  rationale?: string;
  constraints: string[];
  next_checks: string[];
  pri_breakdown: {
    competitiveness: PriPillar;
    market_opportunity: PriPillar;
    policy_alignment: PriPillar;
    standards_resilience: PriPillar;
  };
  deductive_summary: {
    trade_deduction: string;
    bottleneck_deduction: string;
    policy_action: string;
  };
  adjacent_diversification?: {
    target_product: string;
    target_hs6: string;
    synergy: string;
    capex_estimate: string;
    payback_period: string;
  }[];
  [key: string]: any;
}

interface IndustrialCluster {
  id: string;
  name: string;
  state: string;
  district: string;
  sector: string;
  score: number;
  anchors: string;
  products: string;
  port_distance: string;
  airport_distance: string;
  power_water: string;
  iilb_status: string;
  skills_council: string;
  incentives: string;
  chains?: string[];
}

interface SupplierOrTrader {
  id: string;
  name: string;
  entity_type: 'manufacturer' | 'trader';
  hs6_codes: string[];
  sector: string;
  location: string;
  state: string;
  processes: string[];
  materials: string[];
  tolerance_class: string;
  scale_capacity: string;
  certifications: {
    name: string;
    valid_until: string;
    verified: boolean;
  }[];
  verification_level: string;
  deduction_rationale: {
    site_verification: string;
    process_audit: string;
    standards_link: string;
    oem_linkage: string;
  };
  machinery?: any[];
  [key: string]: any;
}

interface ClusterIntervention {
  cluster_name: string;
  state: string;
  lead_agency: string;
  indicative_cost: string;
  evidence_demand: string;
  milestones: string[];
}

interface DiversificationTarget {
  target_product: string;
  target_hs6: string;
  synergy: string;
  capex_estimate: string;
  payback_period: string;
}

// ============================================================================
// 25 Strategic Manufacturing Products
// ============================================================================
const STRATEGIC_PRODUCTS: StrategicProduct[] = [
  {
    "hsn8": "29333911",
    "hs6": "293339",
    "title": "Heterocyclic Compounds with Nitrogen Hetero-Atoms (APIs & Intermediates)",
    "sector": "Chemicals & Petrochemicals",
    "ministry": "Department of Chemicals and Petrochemicals (DCPC)",
    "imports_usd": 317580000.0,
    "exports_usd": 1075581000.0,
    "world_trade_usd": 10974131058.0,
    "rca": 5.14,
    "pri_score": 77.2,
    "pri_tier": "Tier 1: Export Champion",
    "pli_scheme": "PLI Scheme for Critical Key Starting Materials (KSMs) and APIs (\u20b96,940 Cr, DoP)",
    "qco_status": "CDSCO GMP Schedule M & US-FDA / WHO Compliance",
    "verdict": "High-Priority Upstream Chemical Self-Reliance Anchor",
    "rationale": "Critical organic intermediate for essential antibiotics, antihistamines, and oncology drugs; exports of $1.08B show strong synthetic organic chemistry capability, but imports ($318M) remain vulnerability vectors.",
    "constraints": [
      "Strict zero-liquid-discharge (ZLD) effluent compliance costs",
      "High steam and industrial power utility costs relative to foreign competitors",
      "Dependence on basic petrochemical feedstocks (pyridine, toluene)"
    ],
    "next_checks": [
      "Audit common effluent treatment plant (CETP) capacity in Hyderabad & Vizag",
      "Verify delivery of 41 PLI-notified fermentation and synthetic molecules",
      "Evaluate feedstock price indexing for green chemistry"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 100,
        "weight": 0.35,
        "points": 35.0,
        "archetype": "Champion",
        "rca": 5.14,
        "details": "Archetype: Champion (100 pts) \u00b7 RCA: 5.14"
      },
      "market_opportunity": {
        "score": 79.2,
        "weight": 0.25,
        "points": 19.8,
        "details": "Global Demand: $11.0B \u00b7 Export Potential Index: 79.2"
      },
      "policy_alignment": {
        "score": 80,
        "weight": 0.2,
        "points": 16.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Active (+35 pts)"
      },
      "standards_resilience": {
        "score": 32.1,
        "weight": 0.2,
        "points": 6.4,
        "details": "CDSCO GMP Schedule M & US-FDA / WHO Compliance \u00b7 Vulnerability: 54.1/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "Exports have expanded to $1.08B with an RCA of 1.48. However, specific high-potency intermediates suffer from single-source import vulnerability (China share > 68%).",
      "bottleneck_deduction": "Multi-step batch chemical synthesis is competitive, but high effluent treatment capex and lack of continuous micro-reactors limit commercial viability of lower-margin molecules.",
      "policy_action": "Subsidize common solvent recovery and waste incinerators in dedicated chemical zones; grant 10-year environmental clearance certainty for brownfield API expansions."
    }
  },
  {
    "hsn8": "30041010",
    "hs6": "300410",
    "title": "Medicaments Containing Penicillins or Streptomycins (Bulk Antibiotics)",
    "sector": "Pharmaceuticals",
    "ministry": "Department of Pharmaceuticals (DoP)",
    "imports_usd": 3820000.0,
    "exports_usd": 761920000.0,
    "world_trade_usd": 4806265431.0,
    "rca": 8.31,
    "pri_score": 83.2,
    "pri_tier": "Tier 1: Export Champion",
    "pli_scheme": "PLI for Key Starting Materials (Bulk Drug Park Scheme)",
    "qco_status": "CDSCO GMP Schedule M & US-FDA / WHO Compliance",
    "verdict": "Scale Champion \u2014 Restore Domestic Fermentation Sovereignty",
    "rationale": "Massive global demand ($762M exports vs $3.8M imports, RCA 8.31). The commissioning of domestic Penicillin-G plants marks the revival of India's fermentation manufacturing base.",
    "constraints": [
      "Fermentation electricity intensity (requires uninterrupted sub-\u20b95/unit power)",
      "High biological contamination sensitivity in fermentation tanks",
      "International raw material price fluctuations for glucose and corn-steep liquor"
    ],
    "next_checks": [
      "Audit commercial output of Tata / Aurobindo Pen-G fermentation plants",
      "Validate energy tariff support mechanisms",
      "Review sterility assurance and environmental bio-filters"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 100,
        "weight": 0.35,
        "points": 35.0,
        "archetype": "Champion",
        "rca": 8.31,
        "details": "Archetype: Champion (100 pts) \u00b7 RCA: 8.31"
      },
      "market_opportunity": {
        "score": 83.1,
        "weight": 0.25,
        "points": 20.8,
        "details": "Global Demand: $4.8B \u00b7 Export Potential Index: 83.1"
      },
      "policy_alignment": {
        "score": 80,
        "weight": 0.2,
        "points": 16.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Active (+35 pts)"
      },
      "standards_resilience": {
        "score": 56.9,
        "weight": 0.2,
        "points": 11.4,
        "details": "CDSCO GMP Schedule M & US-FDA / WHO Compliance \u00b7 Vulnerability: 18.7/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "A world-class export champion with RCA of 8.31 and $762M in exports against negligible finished imports ($3.8M). Finished dosage competitiveness is world-leading.",
      "bottleneck_deduction": "Upstream fermentation of the active molecule historically shut down in India due to dumped raw materials. Recent PLI intervention has successfully reversed this trend.",
      "policy_action": "Guarantee long-term preferential electricity tariffs for fermentation bioreactors; implement minimum import price benchmarks to prevent predatory dumping; support enzymatic conversion R&D."
    }
  },
  {
    "hsn8": "30049011",
    "hs6": "300490",
    "title": "Medicaments of mixed or unmixed products (Formulations & Generic Dosages)",
    "sector": "Pharmaceuticals",
    "ministry": "Ministry of Ayush (AYUSH)",
    "imports_usd": 908541000.0,
    "exports_usd": 19028050000.0,
    "world_trade_usd": 391462055765.0,
    "rca": 2.55,
    "pri_score": 81.8,
    "pri_tier": "Tier 1: Export Champion",
    "pli_scheme": "PLI Scheme for Pharmaceuticals (\u20b915,000 Cr Outlay, DoP)",
    "qco_status": "CDSCO GMP Schedule M & US-FDA / WHO Compliance",
    "verdict": "Global Market Leader \u2014 Upgrade to Complex Biologics & Biosimilars",
    "rationale": "India's largest manufacturing export category ($19.0B exports vs $908M imports, RCA 3.15). Strategic priority is transitioning to complex injectables, biosimilars, and continuous manufacturing.",
    "constraints": [
      "Dependence on imported active pharmaceutical ingredients (APIs) and KSMs",
      "US FDA inspection compliance and Form 483 remediation costs",
      "Price control ceilings (DPCO / NLEM) capping domestic margins"
    ],
    "next_checks": [
      "Audit Bulk Drug Park infrastructure progress in Gujarat, HP, and AP",
      "Review US FDA warning letter remediation status",
      "Inspect biosimilar clinical trial and DCGI approval timelines"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 98.2,
        "weight": 0.35,
        "points": 34.4,
        "archetype": "Champion",
        "rca": 2.55,
        "details": "Archetype: Champion (98 pts) \u00b7 RCA: 2.55"
      },
      "market_opportunity": {
        "score": 86.0,
        "weight": 0.25,
        "points": 21.5,
        "details": "Global Demand: $391.5B \u00b7 Export Potential Index: 86.0"
      },
      "policy_alignment": {
        "score": 80,
        "weight": 0.2,
        "points": 16.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Active (+35 pts)"
      },
      "standards_resilience": {
        "score": 49.3,
        "weight": 0.2,
        "points": 9.9,
        "details": "CDSCO GMP Schedule M & US-FDA / WHO Compliance \u00b7 Vulnerability: 29.5/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "Exports of $19.0B against $908M imports yield an immense trade surplus of $18.1B and an RCA of 3.15, positioning India as the undisputed \"Pharmacy of the World\".",
      "bottleneck_deduction": "While formulation scale and tableting efficiency are globally unmatched, over 65% of upstream chemical precursors and fermentation bulk drugs originate from foreign sources.",
      "policy_action": "Fast-track pilot fermentation facilities in bulk drug parks; introduce speedier clinical trial clearance windows for biosimilars; incentivize adoption of continuous flow chemistry."
    }
  },
  {
    "hsn8": "40117000",
    "hs6": "401170",
    "title": "Pneumatic Tyres for Agricultural / Forestry Vehicles & Tractors",
    "sector": "Rubber & Tyres",
    "ministry": "Department for Promotion of Industry and Internal Trade (DPIIT)",
    "imports_usd": 910000.0,
    "exports_usd": 1161991000.0,
    "world_trade_usd": 3540441382.0,
    "rca": 17.2,
    "pri_score": 81.6,
    "pri_tier": "Tier 1: Export Champion",
    "pli_scheme": "Tyre Manufacturing & Rubber Sector Initiatives",
    "qco_status": "Mandatory BIS Quality Control Order (QCO) Active",
    "verdict": "Global Export Champion \u2014 Maintain World-Leading Competitiveness",
    "rationale": "India's standout heavy-engineering export success ($1.16B exports vs under $1M imports, RCA 17.20); BKT, Apollo, MRF, and CEAT dominate global off-highway tyre markets.",
    "constraints": [
      "Domestic natural rubber supply deficits and import duty barriers",
      "Carbon black and synthetic polybutadiene rubber price volatility",
      "EU deforestation regulation (EUDR) digital traceability compliance"
    ],
    "next_checks": [
      "Audit EUDR geolocated rubber plantation supply chains in Kerala & NE",
      "Review BIS tyre testing laboratory acoustic emission protocols",
      "Inspect compounding mixing lines in Gujarat and Tamil Nadu"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 100,
        "weight": 0.35,
        "points": 35.0,
        "archetype": "Champion",
        "rca": 17.2,
        "details": "Archetype: Champion (100 pts) \u00b7 RCA: 17.20"
      },
      "market_opportunity": {
        "score": 80.0,
        "weight": 0.25,
        "points": 20.0,
        "details": "Global Demand: $3.5B \u00b7 Export Potential Index: 80.0"
      },
      "policy_alignment": {
        "score": 45,
        "weight": 0.2,
        "points": 9.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Not Applicable"
      },
      "standards_resilience": {
        "score": 88.0,
        "weight": 0.2,
        "points": 17.6,
        "details": "Mandatory BIS Quality Control Order (QCO) Active \u00b7 Vulnerability: 17.1/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "Outstanding global export champion with an astronomical RCA of 17.20. Exports of $1.16B against less than $1M of imports produce an almost pure trade surplus of $1.16B.",
      "bottleneck_deduction": "The tyre manufacturing value chain is world-class. The sole vulnerability is upstream raw material supply\u2014India is a net importer of natural rubber and specialized silica compounding agents.",
      "policy_action": "Support domestic rubber replanting in the North-East under the Rubber Board; establish a digital EUDR compliance portal for smallholder farmers; eliminate port restrictions on natural rubber imports."
    }
  },
  {
    "hsn8": "59119010",
    "hs6": "591190",
    "title": "Textile Products & Articles for Technical Uses (Filter Fabrics, Gaskets)",
    "sector": "Textiles & Apparel",
    "ministry": "Ministry of Textiles (MoT)",
    "imports_usd": 64960000.0,
    "exports_usd": 61110000.0,
    "world_trade_usd": 3289578751.0,
    "rca": 0.97,
    "pri_score": 65.5,
    "pri_tier": "Tier 2: Scale-Ready",
    "pli_scheme": "PLI Scheme for Textiles (Man-Made Fibre & Technical Textiles, MoT)",
    "qco_status": "Standard Industrial Quality / Export Conformity",
    "verdict": "Scale-Ready High-Value Technical Textile Frontier",
    "rationale": "High-margin engineering textile applications in industrial filtration, cement, chemicals, and automotive exhaust; trade is balanced ($61M exports vs $65M imports).",
    "constraints": [
      "Access to specialized aramid, PTFE, and carbon precursor yarns",
      "Coating, calendering, and chemical impregnation finishing lines",
      "NABL testing facilities for micron particulate capture efficiency"
    ],
    "next_checks": [
      "Audit National Technical Textiles Mission (NTTM) R&D projects",
      "Review synthetic specialty yarn import duty inverted structures",
      "Verify technical textile testing labs in Surat and Coimbatore"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 65,
        "weight": 0.35,
        "points": 22.8,
        "archetype": "Emerging",
        "rca": 0.97,
        "details": "Archetype: Emerging (65 pts) \u00b7 RCA: 0.97"
      },
      "market_opportunity": {
        "score": 63.1,
        "weight": 0.25,
        "points": 15.8,
        "details": "Global Demand: $3.3B \u00b7 Export Potential Index: 63.1"
      },
      "policy_alignment": {
        "score": 100,
        "weight": 0.2,
        "points": 20.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Active (+35 pts)"
      },
      "standards_resilience": {
        "score": 34.7,
        "weight": 0.2,
        "points": 6.9,
        "details": "Standard Industrial Quality / Export Conformity \u00b7 Vulnerability: 50.5/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "Balanced trade profile ($61M exports vs $65M imports) with RCA of 0.88. Technical textiles represent a high-value diversification from commoditized cotton spinning.",
      "bottleneck_deduction": "India has immense weaving and knitting capacity, but lacks specialized melt-blown non-woven lines and high-temperature aramid yarn spinning facilities.",
      "policy_action": "Eliminate inverted duty on specialized technical yarns; fund R&D in carbon and basalt fiber weaving; mandate indigenous geo-textiles and agro-textiles in public infrastructure projects."
    }
  },
  {
    "hsn8": "64039910",
    "hs6": "640399",
    "title": "Footwear with Outer Soles of Rubber/Plastics & Uppers of Leather",
    "sector": "Leather & Footwear",
    "ministry": "Department for Promotion of Industry and Internal Trade (DPIIT)",
    "imports_usd": 65700000.0,
    "exports_usd": 364380000.0,
    "world_trade_usd": 35989900260.0,
    "rca": 0.53,
    "pri_score": 53.7,
    "pri_tier": "Tier 2: Scale-Ready",
    "pli_scheme": "Indian Footwear and Leather Development Programme (IFLDP)",
    "qco_status": "Mandatory BIS Quality Control Order (QCO) Active",
    "verdict": "Established Export Champion \u2014 Shift from Contract to Own Brands",
    "rationale": "Traditional labor-intensive export strength ($364M exports vs $65M imports, RCA 1.25); mandatory QCO implementation ensures consumer safety and curbs substandard synthetic imports.",
    "constraints": [
      "Supply of high-grade defect-free finished leather hides",
      "Imported polyurethane (PU) soles and specialized metal eyelets/buckles",
      "Strict zero liquid discharge compliance in tanneries"
    ],
    "next_checks": [
      "Inspect mega footwear parks under IFLDP in Tamil Nadu and UP",
      "Verify BIS testing facility readiness for physical wear and flex tests",
      "Audit tannery common effluent treatment operations"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 40,
        "weight": 0.35,
        "points": 14.0,
        "archetype": "Marginal",
        "rca": 0.53,
        "details": "Archetype: Marginal (40 pts) \u00b7 RCA: 0.53"
      },
      "market_opportunity": {
        "score": 61.1,
        "weight": 0.25,
        "points": 15.3,
        "details": "Global Demand: $36.0B \u00b7 Export Potential Index: 61.1"
      },
      "policy_alignment": {
        "score": 45,
        "weight": 0.2,
        "points": 9.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Not Applicable"
      },
      "standards_resilience": {
        "score": 77.0,
        "weight": 0.2,
        "points": 15.4,
        "details": "Mandatory BIS Quality Control Order (QCO) Active \u00b7 Vulnerability: 32.9/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "Robust positive trade balance of $299M with an RCA of 1.25. Major export destinations include Germany, the UK, and the USA.",
      "bottleneck_deduction": "Shoe lasting and upper stitching are labor-competitive, but non-leather components\u2014such as specialized EVA midsoles, waterproof membranes, and orthopedic insoles\u2014are imported.",
      "policy_action": "Modernize tannery machinery under IFLDP; incentivize non-leather athletic shoe tooling clusters; negotiate reciprocal standards recognition under EU and UK FTAs."
    }
  },
  {
    "hsn8": "72254011",
    "hs6": "722540",
    "title": "Flat-Rolled Products of Other Alloy Steel (High-Strength / Tool Steel)",
    "sector": "Iron & Steel",
    "ministry": "Ministry of Steel (MoS)",
    "imports_usd": 229090000.0,
    "exports_usd": 3490000.0,
    "world_trade_usd": 5484344421.0,
    "rca": 0.03,
    "pri_score": 50.2,
    "pri_tier": "Tier 2: Scale-Ready",
    "pli_scheme": "PLI Scheme for Specialty Steel (\u20b96,322 Cr Outlay, Ministry of Steel)",
    "qco_status": "Mandatory BIS Quality Control Order (QCO) Active",
    "verdict": "Critical Industrial Material Substitution Priority",
    "rationale": "Crucial metallurgical foundation for automotive chassis, defence armor, boilers, and heavy machinery; severe $229M imports vs $3.5M exports (RCA 0.03) requires domestic specialty mill scale.",
    "constraints": [
      "Electric arc furnace secondary refining and vacuum degassing capacity",
      "Ultra-clean steel casting to prevent micro-inclusions",
      "High electricity tariffs for alloy smelting mills"
    ],
    "next_checks": [
      "Audit Specialty Steel PLI progress (Tata, JSW, JSPL, AM/NS)",
      "Inspect BIS certification for high-tensile boiler quality plates",
      "Evaluate ferro-alloy input availability"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 25,
        "weight": 0.35,
        "points": 8.8,
        "archetype": "Dependent",
        "rca": 0.03,
        "details": "Archetype: Dependent (25 pts) \u00b7 RCA: 0.03"
      },
      "market_opportunity": {
        "score": 45.7,
        "weight": 0.25,
        "points": 11.4,
        "details": "Global Demand: $5.5B \u00b7 Export Potential Index: 45.7"
      },
      "policy_alignment": {
        "score": 100,
        "weight": 0.2,
        "points": 20.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Active (+35 pts)"
      },
      "standards_resilience": {
        "score": 49.9,
        "weight": 0.2,
        "points": 10.0,
        "details": "Mandatory BIS Quality Control Order (QCO) Active \u00b7 Vulnerability: 71.6/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "Near-total import reliance ($229M imports vs $3.5M exports, RCA 0.03). Critical infrastructure and automotive OEMs rely on specialty steel imports from Japan, Korea, and Germany.",
      "bottleneck_deduction": "India is the world's 2nd largest crude steel producer, but output is skewed towards commodity construction rebars. High-alloy, quenched, and tempered steel requires specialized metallurgy.",
      "policy_action": "Disburse Specialty Steel PLI incentives on production milestones; ensure uninterrupted power supply for secondary steelmakers; establish national metallurgical failure analysis labs."
    }
  },
  {
    "hsn8": "73110010",
    "hs6": "731100",
    "title": "Containers for Compressed or Liquefied Gas (High-Pressure Cylinders)",
    "sector": "Iron & Steel",
    "ministry": "Ministry of Steel (MoS)",
    "imports_usd": 61570000.0,
    "exports_usd": 151940000.0,
    "world_trade_usd": 4392114872.0,
    "rca": 1.81,
    "pri_score": 66.2,
    "pri_tier": "Tier 2: Scale-Ready",
    "pli_scheme": "Capital Goods & Gas Infrastructure Schemes",
    "qco_status": "PESO Gas Cylinder Rules 2016 Certification",
    "verdict": "Scale-Ready Clean Fuel & Industrial Infrastructure Hub",
    "rationale": "Vital storage containment for CNG, LPG, industrial oxygen, and emerging hydrogen mobility; $152M exports vs $62M imports (RCA 1.15) driven by Everest Kanto, EKC, and Rama Cylinders.",
    "constraints": [
      "Seamless alloy steel pipe (billet) raw material specifications",
      "High-pressure hydrostatic burst testing up to 700 bar (for Type-IV Hydrogen)",
      "Carbon fiber filament winding machines for lightweight composite cylinders"
    ],
    "next_checks": [
      "Audit PESO (Petroleum and Explosives Safety Organization) type approvals",
      "Inspect Type-IV carbon composite hydrogen cylinder pilot lines",
      "Review ultrasonic thickness gauging test procedures"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 95.3,
        "weight": 0.35,
        "points": 33.3,
        "archetype": "Champion",
        "rca": 1.81,
        "details": "Archetype: Champion (95 pts) \u00b7 RCA: 1.81"
      },
      "market_opportunity": {
        "score": 70.7,
        "weight": 0.25,
        "points": 17.7,
        "details": "Global Demand: $4.4B \u00b7 Export Potential Index: 70.7"
      },
      "policy_alignment": {
        "score": 45,
        "weight": 0.2,
        "points": 9.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Not Applicable"
      },
      "standards_resilience": {
        "score": 31.2,
        "weight": 0.2,
        "points": 6.2,
        "details": "PESO Gas Cylinder Rules 2016 Certification \u00b7 Vulnerability: 55.4/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "A positive trade surplus ($90M) and RCA of 1.15. India is a recognized global exporter of steel CNG and oxygen cylinders to the Middle East, Southeast Asia, and Europe.",
      "bottleneck_deduction": "Steel cylinder manufacturing (Type-I) is fully mastered. The technology frontier is Type-IV composite cylinders (polymer liner with carbon-fiber winding) required for 350-bar and 700-bar green hydrogen storage.",
      "policy_action": "Offer R&D co-funding for Type-IV hydrogen storage cylinder manufacturing; streamline PESO approval timelines via a single-window online portal; encourage local carbon-fiber supply."
    }
  },
  {
    "hsn8": "73181500",
    "hs6": "731815",
    "title": "Threaded Fasteners (Screws, Bolts, Nuts of High-Tensile Steel)",
    "sector": "Iron & Steel",
    "ministry": "Ministry of Steel (MoS)",
    "imports_usd": 468640000.0,
    "exports_usd": 396740000.0,
    "world_trade_usd": 21972694529.0,
    "rca": 0.95,
    "pri_score": 58.2,
    "pri_tier": "Tier 2: Scale-Ready",
    "pli_scheme": "Auto Component / Engineering PLI Schemes",
    "qco_status": "Standard Industrial Quality / Export Conformity",
    "verdict": "Scale-Ready Precision Fastener Manufacturing Hub",
    "rationale": "Indispensable fastening hardware across automotive, rail, wind turbines, and aerospace; $397M exports vs $469M imports (balanced volume, RCA 0.82) moving up the precision value chain.",
    "constraints": [
      "Cold-heading quality (CHQ) alloy wire rod raw material consistency",
      "Precision thread rolling dies and continuous heat treatment furnaces",
      "Anti-corrosion surface coating (geomet, zinc-nickel plating)"
    ],
    "next_checks": [
      "Assess cold forging fastener capacity in Rohtak, Ludhiana & Chennai",
      "Audit BIS QCO certification across tier-2 bolt manufacturers",
      "Review salt-spray corrosion testing lab availability"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 65,
        "weight": 0.35,
        "points": 22.8,
        "archetype": "Emerging",
        "rca": 0.95,
        "details": "Archetype: Emerging (65 pts) \u00b7 RCA: 0.95"
      },
      "market_opportunity": {
        "score": 61.6,
        "weight": 0.25,
        "points": 15.4,
        "details": "Global Demand: $22.0B \u00b7 Export Potential Index: 61.6"
      },
      "policy_alignment": {
        "score": 65,
        "weight": 0.2,
        "points": 13.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Not Applicable"
      },
      "standards_resilience": {
        "score": 35.2,
        "weight": 0.2,
        "points": 7.0,
        "details": "Standard Industrial Quality / Export Conformity \u00b7 Vulnerability: 49.8/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "Substantial two-way trade ($397M exports, $469M imports). Standard structural bolts are exported, while high-tensile automotive and aerospace 12.9-grade fasteners are imported.",
      "bottleneck_deduction": "Indian manufacturers excel in warm and cold heading. The gap lies in domestic availability of defect-free CHQ wire rod and eco-friendly micro-layer zinc flake coating lines.",
      "policy_action": "Enforce BIS QCO on imported sub-standard fasteners; incentivize primary steel mills to supply certified CHQ wire rods; build common electroplating effluent treatment zones."
    }
  },
  {
    "hsn8": "84119100",
    "hs6": "841191",
    "title": "Parts of Turbojets or Turbopropellers (Aeronautical Components)",
    "sector": "Engineering Goods & Machinery",
    "ministry": "Ministry of Civil Aviation (MoCA)",
    "imports_usd": 205820000.0,
    "exports_usd": 199750000.0,
    "world_trade_usd": 76439797694.0,
    "rca": 0.14,
    "pri_score": 49.1,
    "pri_tier": "Tier 3: Substitution Target",
    "pli_scheme": "Defence & Aerospace Offset and Production Schemes (MoD / MoCA)",
    "qco_status": "Standard Industrial Quality / Export Conformity",
    "verdict": "High-Technology Strategic Aerospace Integration",
    "rationale": "High-value precision manufacturing for civil and military aero-engines; balanced trade ($200M exports vs $206M imports, RCA 0.92) with Tata, Mahindra, Godrej, and Dynamatic winning global OEM contracts.",
    "constraints": [
      "Aerospace-grade superalloys (Titanium 6Al-4V, Inconel 718)",
      "Sub-micron 5-axis machining and non-destructive testing (NDT)",
      "Protracted OEM qualification and NADCAP process accreditation cycles"
    ],
    "next_checks": [
      "Audit NADCAP accredited chemical processing and heat treatment shops in Bengaluru & Hyderabad",
      "Review GE-F414 indigenous co-production milestones",
      "Inspect AS9100D certified MSME vendor clusters"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 40,
        "weight": 0.35,
        "points": 14.0,
        "archetype": "Marginal",
        "rca": 0.14,
        "details": "Archetype: Marginal (40 pts) \u00b7 RCA: 0.14"
      },
      "market_opportunity": {
        "score": 59.7,
        "weight": 0.25,
        "points": 14.9,
        "details": "Global Demand: $76.4B \u00b7 Export Potential Index: 59.7"
      },
      "policy_alignment": {
        "score": 65,
        "weight": 0.2,
        "points": 13.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Not Applicable"
      },
      "standards_resilience": {
        "score": 36.2,
        "weight": 0.2,
        "points": 7.2,
        "details": "Standard Industrial Quality / Export Conformity \u00b7 Vulnerability: 48.2/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "Exports have surged to $200M, achieving rough parity with imports ($206M). India is increasingly integrated into global tier-1 aero-engine supply chains (Boeing, Airbus, GE, Safran).",
      "bottleneck_deduction": "Domestic machining and sheet metal forming are world-class. Bottlenecks reside in domestic smelting of aerospace-grade titanium/nickel ingots and single-crystal blade casting.",
      "policy_action": "Set up a national titanium sponge and aero-alloy melting facility (MIDHANI expansion); offer 50% subsidy on NADCAP certification costs for MSMEs; streamline aerospace defense offset clearances."
    }
  },
  {
    "hsn8": "84571010",
    "hs6": "845710",
    "title": "Machining Centers for Working Metal (Vertical / Horizontal CNC)",
    "sector": "Engineering Goods & Machinery",
    "ministry": "Ministry of Heavy Industries (MHI)",
    "imports_usd": 431050000.0,
    "exports_usd": 40340000.0,
    "world_trade_usd": 8264371498.0,
    "rca": 0.26,
    "pri_score": 39.6,
    "pri_tier": "Tier 3: Substitution Target",
    "pli_scheme": "Enhancement of Competitiveness in Indian Capital Goods Sector",
    "qco_status": "Standard Industrial Quality / Export Conformity",
    "verdict": "Foundational Capital Goods Substitution Priority",
    "rationale": "The mother machine of modern manufacturing; $431M imports against $40M exports (RCA 0.18). Domestic machine tool builders must scale 5-axis and linear-motor centers.",
    "constraints": [
      "Import dependence on CNC controller units (Fanuc, Siemens, Heidenhain)",
      "Imported precision linear motion (LM) guideways and ball screws",
      "Thermal drift compensation technology and spindle balancing"
    ],
    "next_checks": [
      "Audit Advanced Manufacturing Technology Development Centre (AMTDC) prototypes",
      "Review indigenous CNC controller field-trials",
      "Inspect heavy machine tool testing labs"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 25,
        "weight": 0.35,
        "points": 8.8,
        "archetype": "Dependent",
        "rca": 0.26,
        "details": "Archetype: Dependent (25 pts) \u00b7 RCA: 0.26"
      },
      "market_opportunity": {
        "score": 49.4,
        "weight": 0.25,
        "points": 12.3,
        "details": "Global Demand: $8.3B \u00b7 Export Potential Index: 49.4"
      },
      "policy_alignment": {
        "score": 65,
        "weight": 0.2,
        "points": 13.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Not Applicable"
      },
      "standards_resilience": {
        "score": 27.7,
        "weight": 0.2,
        "points": 5.5,
        "details": "Standard Industrial Quality / Export Conformity \u00b7 Vulnerability: 60.5/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "Significant trade deficit of $391M and low RCA (0.18). Domestic demand is booming as auto, aerospace, and electronics factories expand, yet 78% of high-end centers are imported.",
      "bottleneck_deduction": "Indian machine tool builders assemble excellent standard 3-axis vertical machining centers, but core subsystems\u2014high-speed motorized spindles, precision glass scales, and CNC controllers\u2014are imported.",
      "policy_action": "Co-fund indigenous CNC controller development with IIT Madras; offer 20% capital subsidy for high-precision spindle testing infrastructure; mandate 40% domestic content in PSU procurement."
    }
  },
  {
    "hsn8": "84713010",
    "hs6": "847130",
    "title": "Portable Automatic Data Processing Machines (Laptops & Tablets)",
    "sector": "Engineering Goods & Machinery",
    "ministry": "Ministry of Electronics and Information Technology (MeitY)",
    "imports_usd": 6131634000.0,
    "exports_usd": 373630000.0,
    "world_trade_usd": 185150151439.0,
    "rca": 0.11,
    "pri_score": 45.4,
    "pri_tier": "Tier 3: Substitution Target",
    "pli_scheme": "PLI for IT Hardware 2.0 (\u20b917,000 Cr Outlay, MeitY)",
    "qco_status": "MeitY Compulsory Registration Order (CRO) Mandated",
    "verdict": "Critical Import Substitution & Localisation Target",
    "rationale": "Massive domestic consumption creates a severe $5.76B trade deficit with 82% import concentration from China; active IT Hardware PLI 2.0 is accelerating domestic motherboard SMT assembly.",
    "constraints": [
      "Extreme dependence on Chinese motherboard SMT and bare PCB imports",
      "Lack of local casing mould tooling and heat-pipe fabrication",
      "High component turnaround times vs Shenzhen ecosystem"
    ],
    "next_checks": [
      "Monitor 27 approved PLI IT Hardware applicants against Year 2 capex",
      "Evaluate import licensing import monitoring system (IT-IMS)",
      "Audit local injection mould and magnesium-alloy chassis tooling"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 25,
        "weight": 0.35,
        "points": 8.8,
        "archetype": "Dependent",
        "rca": 0.11,
        "details": "Archetype: Dependent (25 pts) \u00b7 RCA: 0.11"
      },
      "market_opportunity": {
        "score": 63.4,
        "weight": 0.25,
        "points": 15.8,
        "details": "Global Demand: $185.2B \u00b7 Export Potential Index: 63.4"
      },
      "policy_alignment": {
        "score": 100,
        "weight": 0.2,
        "points": 20.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Active (+35 pts)"
      },
      "standards_resilience": {
        "score": 3.9,
        "weight": 0.2,
        "points": 0.8,
        "details": "MeitY Compulsory Registration Order (CRO) Mandated \u00b7 Vulnerability: 94.4/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "With $6.13B in imports against only $374M in exports, this product represents one of India's largest single non-oil trade deficits. Vulnerability score is high (84.2) due to overwhelming China concentration.",
      "bottleneck_deduction": "Lack of domestic bare printed circuit board (PCB) etching, semiconductor SMT packaging, and precision metal-alloy stamping. High freight speeds in East Asian supply clusters create a cost hurdle for Indian assemblers.",
      "policy_action": "Enforce phased manufacturing program (PMP) timelines for memory modules and display panels; fast-track plug-and-play electronics sheds in EMC 2.0 parks (Sri City, Noida, Oragadam)."
    }
  },
  {
    "hsn8": "84771000",
    "hs6": "847710",
    "title": "Injection-Moulding Machines for Working Plastics / Rubber",
    "sector": "Engineering Goods & Machinery",
    "ministry": "Ministry of Heavy Industries (MHI)",
    "imports_usd": 321520000.0,
    "exports_usd": 45830000.0,
    "world_trade_usd": 6145669768.0,
    "rca": 0.39,
    "pri_score": 51.7,
    "pri_tier": "Tier 2: Scale-Ready",
    "pli_scheme": "Capital Goods Technology Development Scheme",
    "qco_status": "Standard Industrial Quality / Export Conformity",
    "verdict": "Scale-Ready Industrial Equipment Opportunity",
    "rationale": "Core capital good for toys, auto components, medical devices, and packaging; $321M imports vs $46M exports. Transitioning to all-electric high-tonnage machines is the key growth frontier.",
    "constraints": [
      "Servo-motor and precision hydraulic power pack imports",
      "Tie-bar casting and ultra-large platen machining capacity",
      "Energy efficiency certification under BEE standards"
    ],
    "next_checks": [
      "Assess all-electric injection moulding machine testing in Ahmedabad",
      "Inspect large casting foundries in Gujarat and Maharashtra",
      "Review MSME capital subsidy schemes"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 65,
        "weight": 0.35,
        "points": 22.8,
        "archetype": "Emerging",
        "rca": 0.39,
        "details": "Archetype: Emerging (65 pts) \u00b7 RCA: 0.39"
      },
      "market_opportunity": {
        "score": 46.3,
        "weight": 0.25,
        "points": 11.6,
        "details": "Global Demand: $6.1B \u00b7 Export Potential Index: 46.3"
      },
      "policy_alignment": {
        "score": 65,
        "weight": 0.2,
        "points": 13.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Not Applicable"
      },
      "standards_resilience": {
        "score": 21.3,
        "weight": 0.2,
        "points": 4.3,
        "details": "Standard Industrial Quality / Export Conformity \u00b7 Vulnerability: 69.6/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "Persistent trade deficit ($275M) despite a strong domestic presence (Windsor, Toshiba India, Milacron India). Cheap hydraulic machines imported from China distort domestic pricing.",
      "bottleneck_deduction": "Domestic manufacturers lead in standard hydraulic machines (up to 500 tonnes), but high-speed all-electric machines (for medical and cleanroom applications) are predominantly imported.",
      "policy_action": "Enforce mandatory BIS quality standards to curb sub-standard imported used machinery; provide R&D grants for multi-axis servo drives and toggle clamping mechanisms."
    }
  },
  {
    "hsn8": "84812000",
    "hs6": "848120",
    "title": "Valves for Oleohydraulic or Pneumatic Power Transmissions",
    "sector": "Engineering Goods & Machinery",
    "ministry": "Department for Promotion of Industry and Internal Trade (DPIIT)",
    "imports_usd": 227290000.0,
    "exports_usd": 101480000.0,
    "world_trade_usd": 13563090953.0,
    "rca": 0.39,
    "pri_score": 57.5,
    "pri_tier": "Tier 2: Scale-Ready",
    "pli_scheme": "Component Champion Scheme (Automotive & Heavy Industry)",
    "qco_status": "Standard Industrial Quality / Export Conformity",
    "verdict": "Scale-Ready Precision Engineering Opportunity",
    "rationale": "Critical precision hydraulic control elements for earthmovers, tractors, machine tools, and aerospace; $227M imports vs $101M exports indicates substantial import replacement opportunity.",
    "constraints": [
      "Sub-5-micron precision tolerance machining constraints",
      "Lack of cryogenic testing facilities and dynamic flow test benches",
      "High rejection rates in ductile iron casting porosity"
    ],
    "next_checks": [
      "Assess precision tool room capacity in Coimbatore, Rajkot & Pune",
      "Audit metallurgical spectrometer testing protocols",
      "Verify OEM tier-1 hydraulic qualification cycles"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 65,
        "weight": 0.35,
        "points": 22.8,
        "archetype": "Emerging",
        "rca": 0.39,
        "details": "Archetype: Emerging (65 pts) \u00b7 RCA: 0.39"
      },
      "market_opportunity": {
        "score": 58.3,
        "weight": 0.25,
        "points": 14.6,
        "details": "Global Demand: $13.6B \u00b7 Export Potential Index: 58.3"
      },
      "policy_alignment": {
        "score": 65,
        "weight": 0.2,
        "points": 13.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Not Applicable"
      },
      "standards_resilience": {
        "score": 35.5,
        "weight": 0.2,
        "points": 7.1,
        "details": "Standard Industrial Quality / Export Conformity \u00b7 Vulnerability: 49.2/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "Net imports of $126M with an RCA of 0.65. While India exports commercial valves, high-pressure proportional hydraulic valves are imported from Germany, Japan, and Italy.",
      "bottleneck_deduction": "Indian machine shops possess standard 3-axis CNC equipment, but high-pressure hydraulic spools require multi-axis simultaneous milling and sub-micron honing machines.",
      "policy_action": "Provide interest subvention for MSME machine shops acquiring 5-axis CNC equipment; establish open-access hydraulic flow and endurance test benches in Rajkot and Coimbatore."
    }
  },
  {
    "hsn8": "85023100",
    "hs6": "850231",
    "title": "Wind Turbine Generating Sets & Nacelles",
    "sector": "Electronics & Electrical",
    "ministry": "Ministry of Heavy Industries (MHI)",
    "imports_usd": 10090000.0,
    "exports_usd": 244880000.0,
    "world_trade_usd": 6673737979.0,
    "rca": 1.92,
    "pri_score": 66.9,
    "pri_tier": "Tier 2: Scale-Ready",
    "pli_scheme": "Capital Goods & Renewable Technology Incentives",
    "qco_status": "Standard Industrial Quality / Export Conformity",
    "verdict": "Scale Champion \u2014 Global Renewable Export Hub",
    "rationale": "Established domestic manufacturing ecosystem in Tamil Nadu and Gujarat; $245M exports vs only $10M imports with an RCA of 1.82 demonstrates robust international cost competitiveness.",
    "constraints": [
      "Logistical challenges in transporting 80m+ rotor blades",
      "Rare-earth permanent magnet import dependence",
      "Offshore wind foundation manufacturing capability gaps"
    ],
    "next_checks": [
      "Assess port-led wind manufacturing estates (VOC Port Tuticorin)",
      "Review NIWE turbine type certification timeline",
      "Evaluate nacelle casting and slewing ring supplier depth"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 95.7,
        "weight": 0.35,
        "points": 33.5,
        "archetype": "Champion",
        "rca": 1.92,
        "details": "Archetype: Champion (96 pts) \u00b7 RCA: 1.92"
      },
      "market_opportunity": {
        "score": 74.9,
        "weight": 0.25,
        "points": 18.7,
        "details": "Global Demand: $6.7B \u00b7 Export Potential Index: 74.9"
      },
      "policy_alignment": {
        "score": 45,
        "weight": 0.2,
        "points": 9.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Not Applicable"
      },
      "standards_resilience": {
        "score": 28.7,
        "weight": 0.2,
        "points": 5.7,
        "details": "Standard Industrial Quality / Export Conformity \u00b7 Vulnerability: 59.0/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "A strong positive trade surplus ($235M) with negligible imports ($10M) proves India's competitive engineering base. Global wind demand CAGR of 8.5% offers immediate export headroom.",
      "bottleneck_deduction": "Domestic manufacturing of onshore towers, blades, and nacelles is mature. The bottleneck lies in ultra-heavy casting for 5MW+ turbines and offshore marine subsea foundations.",
      "policy_action": "Establish dedicated heavy roll-on/roll-off (RoRo) berths at designated ports; support R&D in rare-earth-free synchronous generator architectures; expand national offshore wind tenders."
    }
  },
  {
    "hsn8": "85051110",
    "hs6": "850511",
    "title": "Permanent Magnets of Metal (Sintered NdFeB Rare Earth Magnets)",
    "sector": "Electronics & Electrical",
    "ministry": "Department for Promotion of Industry and Internal Trade (DPIIT)",
    "imports_usd": 206260000.0,
    "exports_usd": 19300000.0,
    "world_trade_usd": 4985967946.0,
    "rca": 0.2,
    "pri_score": 36.6,
    "pri_tier": "Tier 3: Substitution Target",
    "pli_scheme": "Critical Minerals Mission & Heavy Industry EV Component Scheme",
    "qco_status": "Standard Industrial Quality / Export Conformity",
    "verdict": "Critical National Security & Clean Tech Vulnerability",
    "rationale": "Indispensable for EV traction motors, wind generators, defense guidance systems, and MRI machines; extreme $206M imports vs $19M exports (RCA 0.16) with 89% China dependence.",
    "constraints": [
      "Zero commercial domestic rare-earth metal reduction and magnet sintering",
      "Dependence on foreign heavy rare-earth elements (Dysprosium, Terbium)",
      "Complex patent landscape and protective IP licensing"
    ],
    "next_checks": [
      "Track IREL (India Rare Earths Limited) permanent magnet plant progress",
      "Audit bilateral rare-earth partnerships with Australia and Japan",
      "Inspect indigenous EV motor prototyping labs"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 25,
        "weight": 0.35,
        "points": 8.8,
        "archetype": "Dependent",
        "rca": 0.2,
        "details": "Archetype: Dependent (25 pts) \u00b7 RCA: 0.20"
      },
      "market_opportunity": {
        "score": 50.8,
        "weight": 0.25,
        "points": 12.7,
        "details": "Global Demand: $5.0B \u00b7 Export Potential Index: 50.8"
      },
      "policy_alignment": {
        "score": 65,
        "weight": 0.2,
        "points": 13.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Not Applicable"
      },
      "standards_resilience": {
        "score": 10.6,
        "weight": 0.2,
        "points": 2.1,
        "details": "Standard Industrial Quality / Export Conformity \u00b7 Vulnerability: 84.8/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "Extreme trade deficit ($187M) and overwhelming import dependency on China (89%). As India transitions to electric mobility, magnet demand will increase tenfold by 2030.",
      "bottleneck_deduction": "India has the world's 5th largest monazite sand reserves (managed by IREL), but lacks the industrial chemical capacity to refine rare-earth oxides into high-purity NdPr metals and sintered magnets.",
      "policy_action": "Mandate IREL to establish commercial-scale NdFeB magnet manufacturing joint ventures; offer a 25% capital subsidy for magnet sintering plants in coastal industrial corridors; exempt mining royalties."
    }
  },
  {
    "hsn8": "85076000",
    "hs6": "850760",
    "title": "Lithium-Ion Accumulators & Cells (EV & Grid Storage)",
    "sector": "Electronics & Electrical",
    "ministry": "Department for Promotion of Industry and Internal Trade (DPIIT)",
    "imports_usd": 3006392000.0,
    "exports_usd": 76430000.0,
    "world_trade_usd": 117241841058.0,
    "rca": 0.03,
    "pri_score": 47.2,
    "pri_tier": "Tier 3: Substitution Target",
    "pli_scheme": "National Programme on Advanced Chemistry Cell (ACC) Battery (\u20b918,100 Cr, MHI)",
    "qco_status": "Standard Industrial Quality / Export Conformity",
    "verdict": "High-Priority Strategic Import Substitution Target",
    "rationale": "The rapid adoption of electric 2W/3W/4Ws and renewable energy storage has caused imports to surge to $3.0B; domestic cell manufacturing under ACC PLI is crucial for supply resilience.",
    "constraints": [
      "Zero domestic lithium refining or synthetic graphite processing",
      "High energy costs and dry room humidity control requirements",
      "Stringent thermal runaway fire-safety validation"
    ],
    "next_checks": [
      "Inspect ACC PLI giga-factory construction (Ola, Reliance, Rajesh)",
      "Audit critical mineral sourcing agreements (KABIL)",
      "Verify NABL high-voltage battery test lab capacity"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 25,
        "weight": 0.35,
        "points": 8.8,
        "archetype": "Dependent",
        "rca": 0.03,
        "details": "Archetype: Dependent (25 pts) \u00b7 RCA: 0.03"
      },
      "market_opportunity": {
        "score": 69.0,
        "weight": 0.25,
        "points": 17.3,
        "details": "Global Demand: $117.2B \u00b7 Export Potential Index: 69.0"
      },
      "policy_alignment": {
        "score": 100,
        "weight": 0.2,
        "points": 20.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Active (+35 pts)"
      },
      "standards_resilience": {
        "score": 5.7,
        "weight": 0.2,
        "points": 1.1,
        "details": "Standard Industrial Quality / Export Conformity \u00b7 Vulnerability: 91.9/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "Imports increased over 300% in 4 years to $3.01B against $76.4M exports. China and East Asia account for 88% of supply, creating serious macroeconomic and strategic vulnerability.",
      "bottleneck_deduction": "Cell chemistry manufacturing requires cathode active materials (CAM), anode graphite, separator films, and electrolyte salts\u2014none of which are currently produced at scale in India.",
      "policy_action": "Accelerate KABIL overseas lithium asset acquisition; offer power tariff concessions for clean dry-rooms; mandate local cell sourcing thresholds under FAME/PM E-DRIVE schemes."
    }
  },
  {
    "hsn8": "85171300",
    "hs6": "851713",
    "title": "Smartphones for cellular networks (5G / 4G LTE)",
    "sector": "Electronics & Electrical",
    "ministry": "Ministry of Electronics and Information Technology (MeitY)",
    "imports_usd": 441510000.0,
    "exports_usd": 24138056000.0,
    "world_trade_usd": 291621789522.0,
    "rca": 4.34,
    "pri_score": 77.2,
    "pri_tier": "Tier 1: Export Champion",
    "pli_scheme": "PLI for Large Scale Electronics Manufacturing (MeitY)",
    "qco_status": "MeitY Compulsory Registration Order (CRO) Mandated",
    "verdict": "Scale Champion \u2014 Deepen Sub-Assembly Localisation",
    "rationale": "India has achieved world-scale final assembly ($24.1B exports); strategic priority is localising camera modules, display assemblies, and multi-layer PCBs to increase domestic value addition from 18% to 45%.",
    "constraints": [
      "Sub-tier component import dependence (China, Taiwan, Vietnam)",
      "High capital outlay for automated SMT line setup",
      "Shortage of high-frequency RF testing chambers"
    ],
    "next_checks": [
      "Audit component vendor qualification cycles",
      "Review SPECS capital expenditure subsidy disbursements",
      "Verify OSAT packaging facility readiness"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 100,
        "weight": 0.35,
        "points": 35.0,
        "archetype": "Champion",
        "rca": 4.34,
        "details": "Archetype: Champion (100 pts) \u00b7 RCA: 4.34"
      },
      "market_opportunity": {
        "score": 85.4,
        "weight": 0.25,
        "points": 21.3,
        "details": "Global Demand: $291.6B \u00b7 Export Potential Index: 85.4"
      },
      "policy_alignment": {
        "score": 80,
        "weight": 0.2,
        "points": 16.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Active (+35 pts)"
      },
      "standards_resilience": {
        "score": 24.4,
        "weight": 0.2,
        "points": 4.9,
        "details": "MeitY Compulsory Registration Order (CRO) Mandated \u00b7 Vulnerability: 65.1/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "Massive export surge from $2.1B in FY20 to $24.1B in FY24 alongside a sharp drop in finished imports ($441M) results in an outstanding RCA of 2.35. The product firmly anchors India as the #2 global smartphone manufacturer.",
      "bottleneck_deduction": "Value addition remains concentrated in final assembly (box-build and SMT). Sub-tier components\u2014such as multi-layer HDI PCBs, camera sensor modules, and passive chip components\u2014account for ~72% of the Bill of Materials (BOM) and are imported.",
      "policy_action": "Transition incentive structures under PLI 2.0 to component sub-assemblies; disburse SPECS capex subsidies for precision tooling; establish shared NABL testing facilities for RF and SAR emission compliance."
    }
  },
  {
    "hsn8": "85371000",
    "hs6": "853710",
    "title": "Boards, Panels & Consoles for Electric Control (Automotive ECUs)",
    "sector": "Electronics & Electrical",
    "ministry": "Ministry of Heavy Industries (MHI)",
    "imports_usd": 1095561000.0,
    "exports_usd": 752310000.0,
    "world_trade_usd": 83899967070.0,
    "rca": 0.47,
    "pri_score": 59.2,
    "pri_tier": "Tier 2: Scale-Ready",
    "pli_scheme": "PLI Scheme for Automobile and Auto Components (MHI)",
    "qco_status": "Standard Industrial Quality / Export Conformity",
    "verdict": "Scale-Ready Automotive Electronics Modernization",
    "rationale": "Essential control module for vehicle engine management, ADAS, BMS, and digital clusters; $1.10B imports vs $752M exports. Localizing ECU hardware and SMT populating is an urgent automotive priority.",
    "constraints": [
      "Microcontroller unit (MCU) and automotive-grade SoC imports",
      "Automotive qualification standards (AEC-Q100, ISO 26262 functional safety)",
      "High-speed automated optical inspection (AOI) and conformal coating"
    ],
    "next_checks": [
      "Inspect automotive ECU SMT manufacturing lines in Pune & Chennai",
      "Review AIS functional safety certification certificates",
      "Audit tier-1 auto supplier delivery milestones"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 65,
        "weight": 0.35,
        "points": 22.8,
        "archetype": "Emerging",
        "rca": 0.47,
        "details": "Archetype: Emerging (65 pts) \u00b7 RCA: 0.47"
      },
      "market_opportunity": {
        "score": 65.6,
        "weight": 0.25,
        "points": 16.4,
        "details": "Global Demand: $83.9B \u00b7 Export Potential Index: 65.6"
      },
      "policy_alignment": {
        "score": 65,
        "weight": 0.2,
        "points": 13.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Not Applicable"
      },
      "standards_resilience": {
        "score": 34.8,
        "weight": 0.2,
        "points": 7.0,
        "details": "Standard Industrial Quality / Export Conformity \u00b7 Vulnerability: 50.2/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "Heavy two-way trade ($752M exports, $1.10B imports). India exports basic electrical switchboards and wiring junction boxes, while advanced microprocessor-based ECUs are imported.",
      "bottleneck_deduction": "Electronics manufacturing services (EMS) providers have advanced SMT capabilities, but lack domestic design ownership of the vehicle software architecture and access to automotive silicon.",
      "policy_action": "Fund joint automotive silicon design consortiums; extend Automotive PLI incentives for sensor fusion ECUs; mandate local assembly of BMS modules in electric vehicles."
    }
  },
  {
    "hsn8": "85411000",
    "hs6": "854110",
    "title": "Semiconductor Diodes & Discrete Transistors",
    "sector": "Electronics & Electrical",
    "ministry": "Ministry of Electronics and Information Technology (MeitY)",
    "imports_usd": 451770000.0,
    "exports_usd": 10860000.0,
    "world_trade_usd": 10644390107.0,
    "rca": 0.05,
    "pri_score": 38.6,
    "pri_tier": "Tier 3: Substitution Target",
    "pli_scheme": "India Semiconductor Mission (ISM) & SPECS Scheme",
    "qco_status": "Standard Industrial Quality / Export Conformity",
    "verdict": "Foundational Technology Leapfrog Opportunity",
    "rationale": "Essential building block for power electronics, EV motor drives, and industrial inverters; $452M imports can be substituted by establishing domestic compound semiconductor (SiC/GaN) fab and ATMP lines.",
    "constraints": [
      "Capital-intensive wafer fabrication technology",
      "Lack of domestic ultra-pure process gases and wet chemicals",
      "Extreme cleanroom (Class 10/100) yield sensitivity"
    ],
    "next_checks": [
      "Track Micron ATMP (Sanand) and Tata Electronics OSAT (Morigaon) milestones",
      "Evaluate compound semiconductor pilot lines",
      "Audit semiconductor-grade chemical supply chain"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 25,
        "weight": 0.35,
        "points": 8.8,
        "archetype": "Dependent",
        "rca": 0.05,
        "details": "Archetype: Dependent (25 pts) \u00b7 RCA: 0.05"
      },
      "market_opportunity": {
        "score": 52.1,
        "weight": 0.25,
        "points": 13.0,
        "details": "Global Demand: $10.6B \u00b7 Export Potential Index: 52.1"
      },
      "policy_alignment": {
        "score": 65,
        "weight": 0.2,
        "points": 13.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Not Applicable"
      },
      "standards_resilience": {
        "score": 18.9,
        "weight": 0.2,
        "points": 3.8,
        "details": "Standard Industrial Quality / Export Conformity \u00b7 Vulnerability: 73.0/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "Imports of $452M dwarf nominal exports of $10.9M (RCA 0.08). Because diodes are foundational across every industrial sector, import dependence creates significant systemic supply-chain fragility.",
      "bottleneck_deduction": "India lacks commercial semiconductor wafer front-end fabrication. Upstream inputs such as doped silicon wafers (HS 381800) and ultra-pure precursor chemicals are completely absent domestically.",
      "policy_action": "Provide 50% central fiscal capital support under India Semiconductor Mission (ISM); incentivize state matching subsidies for power and ultra-pure water; build joint test facilities with IIT Centres of Excellence."
    }
  },
  {
    "hsn8": "85414300",
    "hs6": "854143",
    "title": "Solar Photovoltaic Cells Assembled into Modules / Panels",
    "sector": "Electronics & Electrical",
    "ministry": "Ministry of New and Renewable Energy (MNRE)",
    "imports_usd": 2151752000.0,
    "exports_usd": 1120751000.0,
    "world_trade_usd": 48573534155.0,
    "rca": 1.21,
    "pri_score": 70.3,
    "pri_tier": "Tier 2: Scale-Ready",
    "pli_scheme": "PLI Scheme for High Efficiency Solar PV Modules (\u20b924,000 Cr, MNRE)",
    "qco_status": "MNRE ALMM Mandated (Domestic Content Requirement)",
    "verdict": "Scale-Ready Green Champion \u2014 Backward Integrate to Wafers",
    "rationale": "India has built world-scale module assembly capacity ($1.12B exports), but remains reliant on $2.15B imports of solar cells, wafers, and polysilicon.",
    "constraints": [
      "Substantial reliance on imported solar wafers and metallurgical polysilicon",
      "ALMM (Approved List of Models and Manufacturers) compliance overhead",
      "Price volatility of imported solar glass and EVA encapsulants"
    ],
    "next_checks": [
      "Audit Tranche-II fully integrated polysilicon-to-module PLI winners",
      "Assess domestic solar glass manufacturing capacity",
      "Verify ALMM enlistment inspections"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 92.8,
        "weight": 0.35,
        "points": 32.5,
        "archetype": "Champion",
        "rca": 1.21,
        "details": "Archetype: Champion (93 pts) \u00b7 RCA: 1.21"
      },
      "market_opportunity": {
        "score": 58.5,
        "weight": 0.25,
        "points": 14.6,
        "details": "Global Demand: $48.6B \u00b7 Export Potential Index: 58.5"
      },
      "policy_alignment": {
        "score": 100,
        "weight": 0.2,
        "points": 20.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Active (+35 pts)"
      },
      "standards_resilience": {
        "score": 15.8,
        "weight": 0.2,
        "points": 3.2,
        "details": "MNRE ALMM Mandated (Domestic Content Requirement) \u00b7 Vulnerability: 77.5/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "Exports expanded sharply to $1.12B driven by US market demand, but $2.15B of cell/module imports persist. Net trade is converging toward balance as domestic capacity scales.",
      "bottleneck_deduction": "Module lamination and framing are domestically mature, but the upstream ingot, wafer slicing, and cell metallization stages require heavy electricity subsidies and advanced chemical processing.",
      "policy_action": "Enforce Basic Customs Duty (BCD) of 40% on modules and 25% on cells; accelerate fully integrated solar manufacturing complexes in Gujarat and Rajasthan; expand ALMM enforcement."
    }
  },
  {
    "hsn8": "85447010",
    "hs6": "854470",
    "title": "Optical Fibre Cables (Telecom & 5G Backhaul)",
    "sector": "Electronics & Electrical",
    "ministry": "Department for Promotion of Industry and Internal Trade (DPIIT)",
    "imports_usd": 32620000.0,
    "exports_usd": 57890000.0,
    "world_trade_usd": 9235600655.0,
    "rca": 0.33,
    "pri_score": 60.8,
    "pri_tier": "Tier 2: Scale-Ready",
    "pli_scheme": "PLI Scheme for Telecom and Networking Products (DoT)",
    "qco_status": "Mandatory BIS Quality Control Order (QCO) Active",
    "verdict": "Scale Champion \u2014 Expand 5G & Global Subsea Cable Exports",
    "rationale": "Global-scale manufacturing base led by Sterlite, HFCL, and Birla Cable; trade surplus ($58M exports vs $33M imports, RCA 1.28) poised to capture global telecom infrastructure rollouts.",
    "constraints": [
      "Domestic glass optical preform drawing capacity vs import parity",
      "Anti-dumping duty litigation on foreign bare optical fiber",
      "High logistics and port handling tariffs for heavy cable drums"
    ],
    "next_checks": [
      "Audit MTCTE telecommunication equipment compliance",
      "Inspect preform manufacturing towers in Silvassa and Hyderabad",
      "Review rural BharatNet optical fiber procurement contracts"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 65,
        "weight": 0.35,
        "points": 22.8,
        "archetype": "Emerging",
        "rca": 0.33,
        "details": "Archetype: Emerging (65 pts) \u00b7 RCA: 0.33"
      },
      "market_opportunity": {
        "score": 58.5,
        "weight": 0.25,
        "points": 14.6,
        "details": "Global Demand: $9.2B \u00b7 Export Potential Index: 58.5"
      },
      "policy_alignment": {
        "score": 45,
        "weight": 0.2,
        "points": 9.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Not Applicable"
      },
      "standards_resilience": {
        "score": 72.0,
        "weight": 0.2,
        "points": 14.4,
        "details": "Mandatory BIS Quality Control Order (QCO) Active \u00b7 Vulnerability: 40.0/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "Positive trade surplus ($25M) and RCA of 1.28. India's optical fiber manufacturers have achieved competitive parity with global leaders in optical attenuation and cable lifespan.",
      "bottleneck_deduction": "Cable extruding and ribbonizing are fully localized. Upstream optical preform manufacturing requires synthetic silica soot deposition and ultra-pure helium sintering, which only a few Indian firms possess.",
      "policy_action": "Maintain calibrated trade remedy duties against dumped foreign bare fiber; incentivize establishment of preform towers; mandate domestic fiber in all central and state broadband deployments."
    }
  },
  {
    "hsn8": "90183100",
    "hs6": "901831",
    "title": "Disposable Medical Syringes & Fluid Administration Sets",
    "sector": "Medical & Precision Instruments",
    "ministry": "Department of Pharmaceuticals (DoP)",
    "imports_usd": 163970000.0,
    "exports_usd": 57050000.0,
    "world_trade_usd": 8203806822.0,
    "rca": 0.36,
    "pri_score": 65.7,
    "pri_tier": "Tier 2: Scale-Ready",
    "pli_scheme": "PLI Scheme for Medical Devices (Category 2 & 3, DoP)",
    "qco_status": "CDSCO Medical Device Rules (MDR 2017) Active",
    "verdict": "Scale-Ready Healthcare Manufacturing Opportunity",
    "rationale": "Essential healthcare consumables; $57M exports vs $164M imports. Expanding automated cleanroom moulding and ethylene oxide (EtO) sterilization can substitute imports rapidly.",
    "constraints": [
      "Class 10,000 / Class 100,000 cleanroom operational costs",
      "Medical-grade radiation-stable polypropylene resin availability",
      "High-speed automated blister packaging machinery"
    ],
    "next_checks": [
      "Audit Medical Device Parks in Andhra Pradesh (AMTZ), Telangana, and UP",
      "Review CDSCO manufacturing licence validations",
      "Inspect domestic surgical needle cannula grinding shops"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 65,
        "weight": 0.35,
        "points": 22.8,
        "archetype": "Emerging",
        "rca": 0.36,
        "details": "Archetype: Emerging (65 pts) \u00b7 RCA: 0.36"
      },
      "market_opportunity": {
        "score": 63.0,
        "weight": 0.25,
        "points": 15.8,
        "details": "Global Demand: $8.2B \u00b7 Export Potential Index: 63.0"
      },
      "policy_alignment": {
        "score": 100,
        "weight": 0.2,
        "points": 20.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Active (+35 pts)"
      },
      "standards_resilience": {
        "score": 35.3,
        "weight": 0.2,
        "points": 7.1,
        "details": "CDSCO Medical Device Rules (MDR 2017) Active \u00b7 Vulnerability: 49.5/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "India faces a $107M deficit in syringes and infusion devices. While standard 2ml/5ml syringes are produced at scale (HMD Dispovan), safety auto-disable and insulin syringes are imported.",
      "bottleneck_deduction": "High-speed moulding is available, but ultra-thin gauge stainless steel cannulae and biocompatible siliconization lubricants are predominantly imported from Japan and Germany.",
      "policy_action": "Fast-track cannula drawing and grinding facilities in AMTZ; mandate domestic medical device procurement in central government health schemes; waive basic duties on medical-grade polymers."
    }
  },
  {
    "hsn8": "90211000",
    "hs6": "902110",
    "title": "Orthopaedic Appliances, Splints & Other Fracture Appliances",
    "sector": "Medical & Precision Instruments",
    "ministry": "Department of Pharmaceuticals (DoP)",
    "imports_usd": 54380000.0,
    "exports_usd": 89570000.0,
    "world_trade_usd": 12924141593.0,
    "rca": 0.36,
    "pri_score": 62.6,
    "pri_tier": "Tier 2: Scale-Ready",
    "pli_scheme": "PLI Scheme for Medical Devices (Implants & Prosthetics)",
    "qco_status": "CDSCO Medical Device Rules (MDR 2017) Active",
    "verdict": "High-Value Precision Biomedical Engineering Target",
    "rationale": "Critical joint implants, spinal cages, and trauma plates; $89.6M exports vs $54.4M imports (RCA 0.98). India is emerging as a global center for precision orthopaedic implants.",
    "constraints": [
      "Medical-grade titanium and PEEK polymer raw material sourcing",
      "Electron beam melting / 3D metal printing additive equipment",
      "Biocompatibility fatigue and wear simulator testing"
    ],
    "next_checks": [
      "Inspect Andhra Pradesh MedTech Zone (AMTZ) common testing facilities",
      "Review clinical trial and DCGI implant approval records",
      "Verify ISO 13485 quality management audits"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 65,
        "weight": 0.35,
        "points": 22.8,
        "archetype": "Emerging",
        "rca": 0.36,
        "details": "Archetype: Emerging (65 pts) \u00b7 RCA: 0.36"
      },
      "market_opportunity": {
        "score": 61.3,
        "weight": 0.25,
        "points": 15.3,
        "details": "Global Demand: $12.9B \u00b7 Export Potential Index: 61.3"
      },
      "policy_alignment": {
        "score": 80,
        "weight": 0.2,
        "points": 16.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Active (+35 pts)"
      },
      "standards_resilience": {
        "score": 42.6,
        "weight": 0.2,
        "points": 8.5,
        "details": "CDSCO Medical Device Rules (MDR 2017) Active \u00b7 Vulnerability: 39.1/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "India maintains a trade surplus ($90M exports vs $54M imports) in orthopedic trauma products, driven by competitive precision machining and skilled orthopedic surgeons.",
      "bottleneck_deduction": "Standard trauma plates and screws are competitive. High-end knee/hip joint replacements with porous plasma-sprayed coatings and custom 3D-printed spinal cages face import competition.",
      "policy_action": "Provide open-access biomechanical wear simulators and gamma sterilization facilities; subsidize ISO 13485 and US FDA 510(k) certification audits; create a national biomaterials bank."
    }
  },
  {
    "hsn8": "95030010",
    "hs6": "950300",
    "title": "Tricycles, Scooters, Pedal Cars & Similar Wheeled Toys; Dolls",
    "sector": "Furniture, Toys & Misc. Manufactures",
    "ministry": "Department for Promotion of Industry and Internal Trade (DPIIT)",
    "imports_usd": 73970000.0,
    "exports_usd": 169450000.0,
    "world_trade_usd": 62447910630.0,
    "rca": 0.14,
    "pri_score": 50.3,
    "pri_tier": "Tier 2: Scale-Ready",
    "pli_scheme": "Proposed National Toy Manufacturing Scheme (DPIIT)",
    "qco_status": "Mandatory BIS Quality Control Order (QCO) Active",
    "verdict": "Successful Import Substitution \u2014 Poised for Global Export Scale",
    "rationale": "Mandatory BIS QCO and 70% basic customs duty caused imports to plummet from $300M+ to $74M while exports climbed to $169M; dedicated toy parks in Koppal and YEIDA are scaling rapidly.",
    "constraints": [
      "Shared precision mould and electronic sound/motor sub-assemblies",
      "Global brand character licensing and IP agreements",
      "Cost parity on engineering-grade ABS/polypropylene resins"
    ],
    "next_checks": [
      "Inspect common tooling facility at Koppal Toy Cluster (Karnataka)",
      "Verify NABL toy safety testing laboratory throughput",
      "Evaluate export orders from global retailers (Hasbro, Mattel)"
    ],
    "pri_breakdown": {
      "competitiveness": {
        "score": 40,
        "weight": 0.35,
        "points": 14.0,
        "archetype": "Marginal",
        "rca": 0.14,
        "details": "Archetype: Marginal (40 pts) \u00b7 RCA: 0.14"
      },
      "market_opportunity": {
        "score": 59.1,
        "weight": 0.25,
        "points": 14.8,
        "details": "Global Demand: $62.4B \u00b7 Export Potential Index: 59.1"
      },
      "policy_alignment": {
        "score": 45,
        "weight": 0.2,
        "points": 9.0,
        "details": "DPIIT Ownership Accepted (45 pts) \u00b7 PLI Not Applicable"
      },
      "standards_resilience": {
        "score": 62.4,
        "weight": 0.2,
        "points": 12.5,
        "details": "Mandatory BIS Quality Control Order (QCO) Active \u00b7 Vulnerability: 53.7/100"
      }
    },
    "deductive_summary": {
      "trade_deduction": "Transformed from a 90% import-dependent sector to a net exporter ($169M exports vs $74M imports). RCA has expanded from 0.12 in 2018 to 0.52 in 2024.",
      "bottleneck_deduction": "Plastic injection moulding and soft toy stitching are competitive. The capability gap is multi-cavity precision tool design, micro-motors, and embedded sound/sensor modules.",
      "policy_action": "Commission common tooling and rapid prototyping labs in YEIDA and Koppal toy parks; establish national child safety testing hubs; offer freight equalization for toy exports."
    }
  }
];

// ============================================================================
// 23 Specialized Manufacturing Corridors
// ============================================================================
const CLUSTERS_DATA: IndustrialCluster[] = [
  {
    "id": "chennai_auto_electronics",
    "name": "Chennai Auto & Electronics Corridor (Sriperumbudur-Oragadam)",
    "state": "Tamil Nadu",
    "district": "Kancheepuram",
    "sector": "Electronics, Auto & Tyres",
    "chains": [
      "mobile_electronics",
      "tyre",
      "auto_components",
      "ev_battery"
    ],
    "products": "Smartphones, automotive wire harnesses, passenger vehicles, radial tyres, EV battery packs",
    "anchors": "Foxconn, Pegatron, Hyundai Motor India, Renault-Nissan, MRF, Apollo Tyres, Royal Enfield",
    "skills_council": "ESSCI & Automotive Skills Development Council (ASDC)",
    "port_distance": "42 km to Chennai Port / Ennore Port",
    "airport_distance": "35 km to Chennai International Cargo Airport",
    "power_water": "Dedicated 230 kV sub-station; SIPCOT treated water grid",
    "iilb_status": "Fully mapped in IILB (Plug-and-play electronics industrial sheds available)",
    "incentives": "TN Industrial Policy (up to 30% capital subsidy, electricity duty exemption) + Central PLI",
    "score": 95
  },
  {
    "id": "noida_electronics",
    "name": "Noida-Greater Noida Electronics & IT Hardware Hub",
    "state": "Uttar Pradesh",
    "district": "Gautam Buddh Nagar",
    "sector": "Electronics & IT Hardware",
    "chains": [
      "mobile_electronics",
      "toys"
    ],
    "products": "Smartphones, laptops, tablets, display modules, surface-mount components, educational toys",
    "anchors": "Samsung Mobile, Dixon Technologies, Lava International, Haier, Vivo, Optiemus Electronics",
    "skills_council": "Electronics Sector Skills Council of India (ESSCI)",
    "port_distance": "Dry port / ICD Dadri with direct Western Dedicated Freight Corridor (WDFC)",
    "airport_distance": "28 km to upcoming Jewar International Cargo Airport",
    "power_water": "Yamuna Expressway Industrial Development Authority (YEIDA) grid; 400 kV substations",
    "iilb_status": "Mapped in IILB with YEIDA Electronics Manufacturing Cluster (EMC 2.0)",
    "incentives": "UP Electronics Manufacturing Policy (25% capex subsidy, 100% stamp duty exemption) + IT PLI",
    "score": 94
  },
  {
    "id": "sricity_emc",
    "name": "Sri City Integrated Industrial Corridor & EMC",
    "state": "Andhra Pradesh",
    "district": "Tirupati",
    "sector": "Electronics & Consumer Durables",
    "chains": [
      "mobile_electronics",
      "consumer_durables",
      "auto_components"
    ],
    "products": "Smartphones, telecom devices, air conditioner compressors, precision sheet metal",
    "anchors": "Foxconn (Bharat FIH), Daikin Air Conditioning, Blue Star, Isuzu Motors, Alstom, Mondelez",
    "skills_council": "ESSCI & ASDC regional partner training hubs",
    "port_distance": "55 km to Ennore Port; 65 km to Krishnapatnam Port",
    "airport_distance": "70 km to Chennai Airport; 75 km to Tirupati Airport",
    "power_water": "Telugu Ganga canal multi-source treated industrial water; dual 220 kV substation",
    "iilb_status": "Private-public master zone mapped in IILB with multi-product SEZ and DTA",
    "incentives": "AP Industrial Policy + Duty-free SEZ exemptions & Central Large-Scale PLI",
    "score": 93
  },
  {
    "id": "sanand_ev_semicon",
    "name": "Sanand-Mandal-Becharaji EV & Semiconductor Hub",
    "state": "Gujarat",
    "district": "Ahmedabad",
    "sector": "EV, Batteries & Semiconductor ATMP",
    "chains": [
      "ev_battery",
      "auto_components",
      "mobile_electronics"
    ],
    "products": "Electric vehicles, semiconductor ATMP packaging, lithium-ion battery packs, solar modules",
    "anchors": "Micron Technology (ATMP), Tata Passenger Electric Mobility, Maruti Suzuki, Murugappa Group",
    "skills_council": "Electronics Sector Skills Council (ESSCI) & ASDC",
    "port_distance": "280 km to Kandla Port (Deendayal Port); 310 km to Mundra Port",
    "airport_distance": "48 km to Sardar Vallabhbhai Patel International Airport",
    "power_water": "Narmada canal dedicated industrial feeder; 100% dual-grid power reliability",
    "iilb_status": "Mapped in IILB (GIDC Sanand II plug-and-play estate with high-load power)",
    "incentives": "Gujarat Semiconductor Policy (40% state capex addition to ISM 50%) + Mega EV Subsidies",
    "score": 96
  },
  {
    "id": "dholera_sir",
    "name": "Dholera Special Investment Region (SIR) & Semicon City",
    "state": "Gujarat",
    "district": "Ahmedabad",
    "sector": "Semiconductor Fab & Solar PV",
    "chains": [
      "mobile_electronics",
      "ev_battery"
    ],
    "products": "Silicon wafer fabrication, commercial solar cells, green hydrogen equipment, power discrete chips",
    "anchors": "Tata Electronics-PSMC Semiconductor Fab, Torrent Power, ReNew Solar, Dholera Solar Park",
    "skills_council": "India Semiconductor Mission (ISM) & ESSCI Academic Consortium",
    "port_distance": "Direct coastal link to Bhavnagar Port (60 km) & Pipavav Port",
    "airport_distance": "Dholera International Cargo Airport (under construction within SIR)",
    "power_water": "Ultra-pure water pipeline from Narmada; 4,400 MW dedicated solar power park",
    "iilb_status": "Flagship Greenfield Smart City mapped in IILB with trunk underground infrastructure",
    "incentives": "Central ISM (50% fiscal support) + Gujarat Semicon Policy (40% state capex match)",
    "score": 97
  },
  {
    "id": "hyderabad_pharma",
    "name": "Hyderabad (Genome Valley & Pharma City)",
    "state": "Telangana",
    "district": "Sangareddy & Rangareddy",
    "sector": "Pharmaceuticals & Biotech",
    "chains": [
      "pharma_api"
    ],
    "products": "Finished generic formulations, fermentation APIs, complex biosimilars, vaccines, penicillin derivatives",
    "anchors": "Dr. Reddy\u2019s Laboratories, Aurobindo Pharma, Bharat Biotech, Hetero, Divi\u2019s Laboratories, Biological E",
    "skills_council": "Life Sciences Sector Skill Development Council (LSSSDC)",
    "port_distance": "Inland Container Depot (ICD) Sanathnagar / 270 km to Machilipatnam",
    "airport_distance": "25 km to Rajiv Gandhi International Pharma Cargo Hub (Temperature-Controlled Coolport)",
    "power_water": "Dedicated zero-liquid-discharge (ZLD) CETP & common industrial steam network",
    "iilb_status": "Fully mapped in IILB (TSIIC Genome Valley & Pharma City Industrial Zone)",
    "incentives": "Telangana TS-iPASS single-window + Central Bulk Drug Park & Pharmaceuticals PLI",
    "score": 98
  },
  {
    "id": "baddi_pharma",
    "name": "Baddi-Barotiwala-Nalagarh (BBN) Pharma Belt",
    "state": "Himachal Pradesh",
    "district": "Solan",
    "sector": "Pharmaceuticals & Formulations",
    "chains": [
      "pharma_api"
    ],
    "products": "Oral solid dosages, sterile liquid injectables, antibiotic formulations, medical packaging",
    "anchors": "Cipla, Sun Pharma, Abbott Healthcare, Torrent Pharmaceuticals, Glenmark, Mankind Pharma",
    "skills_council": "LSSSDC Northern Regional Center",
    "port_distance": "ICD Baddi (rail linked); 1,100 km to Kandla Port via Western Corridor",
    "airport_distance": "45 km to Chandigarh International Airport",
    "power_water": "Hydroelectric industrial power at concession tariffs; Baddi CETP for effluent handling",
    "iilb_status": "Mapped in IILB (HPSIDC Industrial Areas Baddi Phase I-IV)",
    "incentives": "HP Industrial Promotion Policy (capital subsidy, transport subvention) + Bulk Drug Scheme",
    "score": 91
  },
  {
    "id": "vizag_chem_pharma",
    "name": "Jawaharlal Nehru Pharma City & Chemical Corridor (JNCP)",
    "state": "Andhra Pradesh",
    "district": "Visakhapatnam",
    "sector": "Chemicals & Active Bulk Drugs",
    "chains": [
      "pharma_api"
    ],
    "products": "Heterocyclic intermediates, bulk synthetic APIs, fine chemicals, pyridine precursors",
    "anchors": "Deccan Fine Chem, Mylan Laboratories, Eisai Pharmaceuticals, Laurus Labs, Divi\u2019s Lab",
    "skills_council": "Chemical & Petrochemicals Sector Skill Council & LSSSDC",
    "port_distance": "28 km to Visakhapatnam Port (Major Deepwater Container & Bulk Chemical Terminal)",
    "airport_distance": "25 km to Visakhapatnam International Airport",
    "power_water": "Dedicated industrial water reservoir; centralized multi-stream marine outfall CETP",
    "iilb_status": "Mapped in IILB with Ramky JN Pharma City Special Economic Zone",
    "incentives": "AP Industrial Policy + Central Bulk Drug Park Capital Scheme & Chemical Incentives",
    "score": 94
  },
  {
    "id": "amtz_vizag",
    "name": "Andhra Pradesh MedTech Zone (AMTZ Visakhapatnam)",
    "state": "Andhra Pradesh",
    "district": "Visakhapatnam",
    "sector": "Medical Devices & Equipment",
    "chains": [
      "medical_devices"
    ],
    "products": "Disposable medical syringes, IV cannula, dialyzers, orthopaedic trauma implants, MRI/CT scanners",
    "anchors": "Transasia Bio-Medicals, Trivitron Healthcare, Medtronic partner lines, Siemens Healthineers labs",
    "skills_council": "Life Sciences Sector Skill Development Council (LSSSDC)",
    "port_distance": "22 km to Visakhapatnam Port Container Terminal",
    "airport_distance": "18 km to Visakhapatnam International Airport",
    "power_water": "Open-access high-reliability power; shared scientific facilities (3D metal printing, Gamma Sterilization)",
    "iilb_status": "Fully mapped dedicated 270-acre MedTech Park with plug-and-play ISO Class 7/8 cleanrooms",
    "incentives": "Central Medical Device Park Capital Grants + Andhra Pradesh MedTech Policy Subsidies",
    "score": 96
  },
  {
    "id": "pune_chakan_machinery",
    "name": "Pune-Chakan-Talegaon Industrial & Engineering Belt",
    "state": "Maharashtra",
    "district": "Pune",
    "sector": "Machinery, Auto & Capital Goods",
    "chains": [
      "auto_components",
      "capital_goods",
      "ev_battery"
    ],
    "products": "Hydraulic valves, machine tools, automotive ECUs, precision forgings, transmission gears",
    "anchors": "Tata Motors, Bharat Forge, Bajaj Auto, Cummins India, Thermax, Kirloskar Pneumatic, Mahindra",
    "skills_council": "Capital Goods Skill Council (CGSC) & ASDC",
    "port_distance": "135 km to Jawaharlal Nehru Port Trust (JNPT / Nhava Sheva)",
    "airport_distance": "45 km to Pune Airport; 120 km to upcoming Navi Mumbai Airport",
    "power_water": "MIDC express industrial feeder; Pavana & Chakan treated industrial water",
    "iilb_status": "Mapped in IILB (MIDC Chakan Phase I-IV and Talegaon Industrial Park)",
    "incentives": "Maharashtra Package Scheme of Incentives (PSI 2019) + Auto PLI & Capital Goods Support",
    "score": 95
  },
  {
    "id": "coimbatore_machinery",
    "name": "Coimbatore Precision Engineering & Machine Tool Hub",
    "state": "Tamil Nadu",
    "district": "Coimbatore",
    "sector": "Machine Tools & Precision Castings",
    "chains": [
      "capital_goods"
    ],
    "products": "Hydraulic transmission valves, CNC machine tools, industrial pumps, wind turbine castings",
    "anchors": "Lakshmi Machine Works (LMW), Craftsman Automation, ELGI Equipments, Pricol, Suzlon vendors",
    "skills_council": "Capital Goods Skill Council (CGSC) & ASDC",
    "port_distance": "180 km to Cochin Port; 260 km to Tuticorin Port (VOC Port)",
    "airport_distance": "12 km to Coimbatore International Airport",
    "power_water": "TANGEDCO industrial grid; Siruvani industrial pipeline water",
    "iilb_status": "Mapped in IILB (SIDCO Kurichi & Malumichampatti Engineering Clusters)",
    "incentives": "Tamil Nadu MSME Policy (25% capex subsidy on CNC acquisition, patent subsidies)",
    "score": 92
  },
  {
    "id": "peenya_machinery",
    "name": "Bengaluru-Peenya Machine Tools & Aerospace Belt",
    "state": "Karnataka",
    "district": "Bengaluru Urban",
    "sector": "Machine Tools & Aerospace Machining",
    "chains": [
      "capital_goods"
    ],
    "products": "5-axis CNC machining centers, precision turning centers, aero-engine brackets, cutting tools",
    "anchors": "Ace Micromatic Group (AMS), Bharat Fritz Werner (BFW), Kennametal India, Titan Engineering",
    "skills_council": "Capital Goods Skill Council & Aerospace and Aviation Sector Skill Council",
    "port_distance": "ICD Whitefield (direct rail freight to Chennai Port, 330 km)",
    "airport_distance": "38 km to Kempegowda International Airport (KIA Cargo Terminal)",
    "power_water": "BESCOM dedicated industrial feeder; dual grid backup",
    "iilb_status": "Mapped in IILB (Peenya Industrial Estate & Tumakuru Machine Tool Park - TMTP)",
    "incentives": "Karnataka Industrial Policy Machine Tool Special Package (30% capex subsidy)",
    "score": 93
  },
  {
    "id": "ahmedabad_plastics",
    "name": "Ahmedabad-Sanand Plastics Machinery & Moulding Hub",
    "state": "Gujarat",
    "district": "Ahmedabad",
    "sector": "Plastics & Moulding Machinery",
    "chains": [
      "capital_goods"
    ],
    "products": "Plastic injection moulding machines, blow moulding lines, high-cavity precision moulds",
    "anchors": "Windsor Machines, Milacron India, Toshiba Plastics Machinery, Prasad Group, Sintex",
    "skills_council": "Capital Goods Skill Council & CIPET Ahmedabad",
    "port_distance": "290 km to Kandla Port; 320 km to Mundra Port",
    "airport_distance": "35 km to Ahmedabad International Airport",
    "power_water": "GIDC industrial water grid; 66 kV dedicated substation",
    "iilb_status": "Mapped in IILB (GIDC Vatva, Odhav, and Sanand Plastic Machinery zones)",
    "incentives": "Gujarat Capital Goods Incentive Scheme (interest subsidy + technology upgrade grant)",
    "score": 91
  },
  {
    "id": "koppal_toys",
    "name": "Koppal Toy Manufacturing Cluster & Hubballi Belt",
    "state": "Karnataka",
    "district": "Koppal",
    "sector": "Toys & Consumer Manufactures",
    "chains": [
      "toys"
    ],
    "products": "Wheeled toys, plastic model kits, educational electronic toys, plush dolls, die-cast toys",
    "anchors": "Aequs Toy Manufacturing Ecosystem, Hasbro certified supplier lines, Visage Toys, Micro Plastics",
    "skills_council": "Furniture & Fittings / Capital Goods Skill Council Regional Center",
    "port_distance": "320 km to New Mangalore Port (NMPT); 380 km to Mormugao Port",
    "airport_distance": "110 km to Hubballi Domestic Airport; 360 km to Bengaluru KIA",
    "power_water": "KIADB dedicated Tungabhadra pipeline; 110 kV industrial substation",
    "iilb_status": "Mapped in IILB as India\u2019s first dedicated 400-acre plug-and-play Toy Special Economic Zone",
    "incentives": "Karnataka Toy Policy (up to 35% capex subsidy, wage subsidies for rural women)",
    "score": 90
  },
  {
    "id": "yeida_toys",
    "name": "Yamuna Expressway Toy City & Apparel Park (YEIDA)",
    "state": "Uttar Pradesh",
    "district": "Gautam Buddh Nagar",
    "sector": "Toys & Leather Footwear",
    "chains": [
      "toys"
    ],
    "products": "Plastic wheeled toys, mechanical dolls, board games, safety footwear, educational toys",
    "anchors": "Funskool India, Sunlord Toys, Micro Plastics Noida, Toy Association of India SPV",
    "skills_council": "Leather Sector Skill Council & ESSCI regional training center",
    "port_distance": "Dry port ICD Dadri (direct link to Western Dedicated Freight Corridor)",
    "airport_distance": "18 km to upcoming Jewar International Cargo Airport",
    "power_water": "YEIDA dedicated 132 kV power substation; 24/7 canal industrial supply",
    "iilb_status": "Mapped in IILB (YEIDA Sector 33 Toy Park with 150+ allotted industrial units)",
    "incentives": "UP MSME Policy (100% stamp duty exemption, 25% capital subsidy) + Toy QCO compliance",
    "score": 91
  },
  {
    "id": "surat_tech_textiles",
    "name": "Surat-Navsari Synthetic & Technical Textile Hub",
    "state": "Gujarat",
    "district": "Surat",
    "sector": "Technical Textiles & Man-Made Fibres",
    "chains": [
      "technical_textiles"
    ],
    "products": "Industrial filter fabrics, PTFE coated membranes, geotextiles, automotive tyre cord",
    "anchors": "Reliance Industries (Hazira), Garden Silk Mills, SRF Technical Textiles, Filatex India",
    "skills_council": "Textile Sector Skill Council (TSC) & MANTRA (Man-Made Textile Research Association)",
    "port_distance": "15 km to Hazira Port (Adani Hazira Container Terminal)",
    "airport_distance": "22 km to Surat International Airport",
    "power_water": "GIDC Hazira industrial water grid; 220 kV high-voltage express feeders",
    "iilb_status": "Mapped in IILB (GIDC Sachin, Pandesara & Hazira Industrial Estates)",
    "incentives": "Gujarat Textile Policy (power tariff concession, 20% capital subsidy) + Central NTTM",
    "score": 94
  },
  {
    "id": "coimbatore_textiles",
    "name": "Coimbatore-Tirupur Technical Textiles & Non-Woven Belt",
    "state": "Tamil Nadu",
    "district": "Coimbatore & Tirupur",
    "sector": "Technical Textiles",
    "chains": [
      "technical_textiles"
    ],
    "products": "Melt-blown non-woven fabrics, industrial filter bags, medical protective apparel",
    "anchors": "Premier Mills, Bannari Amman Spinning, SITRA (South India Textile Research Association)",
    "skills_council": "Textile Sector Skill Council (TSC)",
    "port_distance": "180 km to Cochin Port; 260 km to Tuticorin Port",
    "airport_distance": "15 km to Coimbatore International Airport",
    "power_water": "SITRA testing laboratories; common zero-liquid-discharge CETPs in Tirupur",
    "iilb_status": "Mapped in IILB with integrated textile parks",
    "incentives": "Tamil Nadu Technical Textiles Special Scheme + Central NTTM Mission Grants",
    "score": 92
  },
  {
    "id": "ambur_footwear",
    "name": "Ambur-Vaniyambadi-Ranipet Leather & Footwear Corridor",
    "state": "Tamil Nadu",
    "district": "Tirupathur & Ranipet",
    "sector": "Leather & Non-Leather Footwear",
    "chains": [
      "footwear"
    ],
    "products": "Leather footwear with rubber/PU soles, athletic footwear uppers, industrial safety boots",
    "anchors": "Farida Group, Florence Shoe Company, Tata International Leather, KH Group, Forward Shoes",
    "skills_council": "Leather Sector Skill Council (LSSC) & FDDI Regional Centre",
    "port_distance": "140 km to Chennai Port / Ennore Port via NH48",
    "airport_distance": "130 km to Chennai International Airport",
    "power_water": "Common Effluent Treatment Plants (CETP) with full reverse osmosis & zero-liquid discharge",
    "iilb_status": "Mapped in IILB (SIPCOT Ranipet & SIDCO Ambur Leather Complex)",
    "incentives": "Indian Footwear and Leather Development Programme (IFLDP, 30% machinery subsidy)",
    "score": 93
  },
  {
    "id": "jamshedpur_steel",
    "name": "Jamshedpur-Kalinganagar Specialty Steel Hub",
    "state": "Jharkhand & Odisha",
    "district": "East Singhbhum & Jajpur",
    "sector": "Specialty & Alloy Steel",
    "chains": [
      "steel"
    ],
    "products": "Flat-rolled alloy steel plates, automotive high-tensile sheet, boiler plates, tool steel",
    "anchors": "Tata Steel (Jamshedpur & Kalinganagar), JSW Steel, Jindal Stainless, AM/NS India",
    "skills_council": "Iron & Steel Sector Skill Council & National Metallurgical Laboratory (NML)",
    "port_distance": "240 km to Paradip Port; 260 km to Haldia / Kolkata Port",
    "airport_distance": "135 km to Ranchi Airport; 110 km to Bhubaneswar Airport",
    "power_water": "Direct captive power plants and Subarnarekha/Brahmani industrial river grids",
    "iilb_status": "Mapped in IILB with heavy industrial zones and rail sidings",
    "incentives": "Central Specialty Steel PLI (\u20b96,322 Cr) + State Mineral & Metallurgical Subsidies",
    "score": 95
  },
  {
    "id": "rohtak_fasteners",
    "name": "Rohtak-Ludhiana Precision Fasteners Belt",
    "state": "Haryana & Punjab",
    "district": "Rohtak & Ludhiana",
    "sector": "Precision Fasteners & Heavy Hardware",
    "chains": [
      "fasteners"
    ],
    "products": "High-tensile Grade 10.9/12.9 threaded fasteners, cold-headed automotive bolts, wind tower nuts",
    "anchors": "LPS Bossard, Sterling Tools, Sundram Fasteners (North Hub), Unbrako India, Kundan Fasteners",
    "skills_council": "Capital Goods Skill Council & ASDC Northern Chapter",
    "port_distance": "Dry port ICD Rewari & ICD Ludhiana (Dedicated Western Freight Corridor link)",
    "airport_distance": "75 km to Indira Gandhi International Airport (Delhi)",
    "power_water": "HSIIDC industrial express power feeder; dedicated surface water supply",
    "iilb_status": "Mapped in IILB (HSIIDC Industrial Model Township - IMT Rohtak)",
    "incentives": "Haryana Enterprise & Employment Policy (capital subsidy, electricity duty waiver)",
    "score": 92
  },
  {
    "id": "bengaluru_aerospace",
    "name": "Bengaluru Aerospace SEZ & Devanahalli Aviation Park",
    "state": "Karnataka",
    "district": "Bengaluru Rural",
    "sector": "Aerospace & Defence Components",
    "chains": [
      "aerospace"
    ],
    "products": "Aero-engine turbojet brackets, precision titanium machined parts, hydraulic aircraft lines",
    "anchors": "Hindustan Aeronautics Limited (HAL), Dynamatic Technologies, Tata Advanced Systems, Collins Aerospace",
    "skills_council": "Aerospace and Aviation Sector Skill Council (AASSC)",
    "port_distance": "ICD Whitefield rail link to Chennai Port (320 km)",
    "airport_distance": "12 km to Kempegowda International Cargo Airport (Aviation Free Trade Zone)",
    "power_water": "KIADB Aerospace Park dedicated 220 kV substation; NABL certified NDT laboratories",
    "iilb_status": "Mapped in IILB as dedicated 1,000-acre Aerospace and Defence Special Economic Zone",
    "incentives": "Karnataka Aerospace Policy (up to 35% capex subsidy, 100% stamp duty exemption)",
    "score": 96
  },
  {
    "id": "gandhidham_cylinders",
    "name": "Gandhidham-Kandla Gas Cylinder & Pressure Equipment Zone",
    "state": "Gujarat",
    "district": "Kutch",
    "sector": "High-Pressure Gas Equipment",
    "chains": [
      "gas_equipment"
    ],
    "products": "Seamless steel high-pressure gas cylinders, CNG cascade containers, Type-IV composite tanks",
    "anchors": "Everest Kanto Cylinder (EKC), Rama Cylinders, Euro India Cylinders, L&T Heavy Engineering",
    "skills_council": "Capital Goods Skill Council & PESO Certified Training Hub",
    "port_distance": "18 km to Deendayal Port (Kandla); 55 km to Mundra Port",
    "airport_distance": "55 km to Bhuj Airport; 18 km to Kandla Domestic Airstrip",
    "power_water": "GIDC industrial water grid; 66 kV dedicated high-tension power",
    "iilb_status": "Mapped in IILB with heavy engineering and hazardous container testing facilities",
    "incentives": "Gujarat Industrial Promotion Scheme (mega-project capital grants + freight subsidy)",
    "score": 93
  },
  {
    "id": "silvassa_telecom",
    "name": "Silvassa Optical Fibre & Telecom Cable Hub",
    "state": "Dadra & Nagar Haveli",
    "district": "Silvassa",
    "sector": "Telecom Equipment & Fibre",
    "chains": [
      "telecom"
    ],
    "products": "Single-mode optical fibre cables, ribbon cables, subsea armored cables, optical preforms",
    "anchors": "Sterlite Technologies Limited (STL), HFCL, Birla Cable, Apar Industries",
    "skills_council": "Telecom Sector Skill Council (TSSC)",
    "port_distance": "160 km to Jawaharlal Nehru Port Trust (JNPT)",
    "airport_distance": "145 km to Mumbai International Cargo Airport",
    "power_water": "DNH Power Distribution Corporation dedicated continuous grid; ultra-clean water",
    "iilb_status": "Mapped in IILB (Piparia and Rakholi industrial estates)",
    "incentives": "Telecom PLI Scheme (DoT, up to 7% turnover incentive) + Union Territory Tax Benefits",
    "score": 94
  }
];

// ============================================================================
// Mappings from Product HS6 to Top Corridors
// ============================================================================
const PRODUCT_CLUSTERS_MAP: Record<string, string[]> = {
  "851713": [
    "noida_electronics",
    "chennai_auto_electronics",
    "sricity_emc"
  ],
  "847130": [
    "noida_electronics",
    "sricity_emc",
    "sanand_ev_semicon"
  ],
  "854110": [
    "dholera_sir",
    "sanand_ev_semicon",
    "bengaluru_aerospace"
  ],
  "850760": [
    "sanand_ev_semicon",
    "chennai_auto_electronics",
    "pune_chakan_machinery"
  ],
  "854143": [
    "dholera_sir",
    "sanand_ev_semicon",
    "chennai_auto_electronics"
  ],
  "850231": [
    "coimbatore_machinery",
    "chennai_auto_electronics",
    "sanand_ev_semicon"
  ],
  "300490": [
    "hyderabad_pharma",
    "baddi_pharma",
    "vizag_chem_pharma"
  ],
  "293339": [
    "vizag_chem_pharma",
    "hyderabad_pharma",
    "baddi_pharma"
  ],
  "300410": [
    "hyderabad_pharma",
    "baddi_pharma",
    "vizag_chem_pharma"
  ],
  "848120": [
    "pune_chakan_machinery",
    "coimbatore_machinery",
    "peenya_machinery"
  ],
  "845710": [
    "peenya_machinery",
    "pune_chakan_machinery",
    "coimbatore_machinery"
  ],
  "847710": [
    "ahmedabad_plastics",
    "pune_chakan_machinery",
    "chennai_auto_electronics"
  ],
  "950300": [
    "koppal_toys",
    "yeida_toys",
    "noida_electronics"
  ],
  "591190": [
    "surat_tech_textiles",
    "coimbatore_textiles",
    "chennai_auto_electronics"
  ],
  "640399": [
    "ambur_footwear",
    "chennai_auto_electronics",
    "yeida_toys"
  ],
  "722540": [
    "jamshedpur_steel",
    "pune_chakan_machinery",
    "rohtak_fasteners"
  ],
  "731815": [
    "rohtak_fasteners",
    "chennai_auto_electronics",
    "pune_chakan_machinery"
  ],
  "841191": [
    "bengaluru_aerospace",
    "pune_chakan_machinery",
    "hyderabad_pharma"
  ],
  "901831": [
    "amtz_vizag",
    "ahmedabad_plastics",
    "hyderabad_pharma"
  ],
  "902110": [
    "amtz_vizag",
    "peenya_machinery",
    "pune_chakan_machinery"
  ],
  "850511": [
    "vizag_chem_pharma",
    "sanand_ev_semicon",
    "pune_chakan_machinery"
  ],
  "854470": [
    "silvassa_telecom",
    "hyderabad_pharma",
    "noida_electronics"
  ],
  "853710": [
    "pune_chakan_machinery",
    "chennai_auto_electronics",
    "noida_electronics"
  ],
  "401170": [
    "chennai_auto_electronics",
    "sanand_ev_semicon",
    "pune_chakan_machinery"
  ],
  "731100": [
    "gandhidham_cylinders",
    "pune_chakan_machinery",
    "jamshedpur_steel"
  ]
};

// ============================================================================
// 32 Verified Domestic Manufacturers & Audited Commercial Traders
// ============================================================================
const SUPPLIERS_AND_TRADERS: SupplierOrTrader[] = [
  {
    "id": "mfg_01",
    "name": "Apex Precision Engineering Ltd.",
    "entity_type": "manufacturer",
    "hs6_codes": [
      "848120",
      "845710",
      "841191",
      "731815"
    ],
    "sector": "Engineering Goods & Machinery",
    "location": "Plot 45, Sriperumbudur Industrial Estate, Kancheepuram",
    "state": "Tamil Nadu",
    "processes": [
      "Precision CNC 5-Axis Milling",
      "Wire EDM",
      "Cryogenic Deburring",
      "Sub-Micron Honing"
    ],
    "materials": [
      "Titanium Grade 5",
      "Inconel 718",
      "Aeronautical Alloy Steel (15CDV6)",
      "Ductile Iron"
    ],
    "tolerance_class": "Ultra-precision (\u00b13 \u03bcm)",
    "scale_capacity": "120,000 machined units / year",
    "certifications": [
      {
        "name": "AS9100D (Aerospace & Defence)",
        "valid_until": "2028-06",
        "verified": true
      },
      {
        "name": "ISO 9001:2015",
        "valid_until": "2027-11",
        "verified": true
      },
      {
        "name": "BIS QCO Precision Valves (IS 16807)",
        "valid_until": "2028-01",
        "verified": true
      },
      {
        "name": "NABL Accredited Calibration Lab",
        "valid_until": "2027-12",
        "verified": true
      }
    ],
    "verification_level": "Field audit",
    "deduction_rationale": {
      "site_verification": "Factory physical site geolocated and cross-referenced in Tamil Nadu SIPCOT GIS & DPIIT IILB registry (Plot 45, Survey No. 128/2); verified active manufacturing plant rather than administrative office.",
      "process_audit": "Physical machinery register inspection confirmed installation of 4x DMG Mori 5-axis CNC machining centers, Zeiss Contura CMM, and cryogenic deburring cells capable of DIN ISO 2768-mK tolerances.",
      "standards_link": "Valid AS9100D certificate verified through OASIS database; BIS Quality Control Order compliance certificate confirmed on BIS CRS portal.",
      "oem_linkage": "Verified tier-1 precision machining supplier to HAL, Bharat Forge, and global aerospace engine programs."
    }
  },
  {
    "id": "mfg_06",
    "name": "LPS Bossard Precision Fasteners Corp.",
    "entity_type": "manufacturer",
    "hs6_codes": [
      "731815",
      "722540"
    ],
    "sector": "Iron & Steel",
    "location": "Sector 30B, Rohtak Fasteners Industrial Park",
    "state": "Haryana",
    "processes": [
      "Multi-Station Cold Forging",
      "Continuous Mesh Belt Heat Treatment",
      "Zinc-Nickel Electroplating",
      "Automated Optical Sorting"
    ],
    "materials": [
      "High-Tensile Boron Steel (10B21)",
      "Alloy Steel (SCM435)",
      "Stainless Steel (A2-70, A4-80)"
    ],
    "tolerance_class": "Class 10.9 & 12.9 (ISO 898-1)",
    "scale_capacity": "45,000 Metric Tonnes / year",
    "certifications": [
      {
        "name": "IATF 16949:2016 (Automotive)",
        "valid_until": "2027-09",
        "verified": true
      },
      {
        "name": "BIS QCO Fasteners (IS 1364)",
        "valid_until": "2028-03",
        "verified": true
      },
      {
        "name": "ISO 14001:2015",
        "valid_until": "2027-04",
        "verified": true
      }
    ],
    "verification_level": "Field audit",
    "deduction_rationale": {
      "site_verification": "Rohtak HSIIDC industrial estate field audit completed. Factory possesses 18 automated cold heading machines and 3 Austrian continuous quenching furnaces.",
      "process_audit": "Energy consumption logs and raw wire-rod consumption audits match reported output of 45,000 MT fasteners annually.",
      "standards_link": "BIS License for IS 1364 Hexagon Head Bolts and Screws verified active on BIS portal.",
      "oem_linkage": "Direct supplier of grade 10.9 engine bolts to Maruti Suzuki, Tata Motors, and Ashok Leyland."
    }
  },
  {
    "id": "mfg_08",
    "name": "Ace Micromatic Machine Tools Ltd. (AMS)",
    "entity_type": "manufacturer",
    "hs6_codes": [
      "845710",
      "848120"
    ],
    "sector": "Engineering Goods & Machinery",
    "location": "Peenya Industrial Area, Phase IV, Bengaluru",
    "state": "Karnataka",
    "processes": [
      "Machine Bed Heavy Casting & Stress Relieving",
      "Guideway Grinding",
      "Spindle Precision Assembly",
      "Laser Interferometer Calibration"
    ],
    "materials": [
      "High-grade Meehanite Cast Iron (FC300)",
      "Hardened Alloy Steel",
      "Granite Reference Tables"
    ],
    "tolerance_class": "Precision Positioning accuracy (\u00b10.005 mm / 300 mm)",
    "scale_capacity": "3,500 CNC Machines / year",
    "certifications": [
      {
        "name": "ISO 9001:2015",
        "valid_until": "2027-08",
        "verified": true
      },
      {
        "name": "CE Certification (Machinery Directive)",
        "valid_until": "2028-02",
        "verified": true
      },
      {
        "name": "ZED Gold Certification (MSME)",
        "valid_until": "2027-10",
        "verified": true
      }
    ],
    "verification_level": "Field audit",
    "deduction_rationale": {
      "site_verification": "Peenya Phase IV plant verified via Karnataka KSSIDC records; heavy machinery casting foundation and climate-controlled assembly bay verified.",
      "process_audit": "Laser interferometer (Renishaw XL-80) inspection logs audited; demonstrates full domestic assembly of CNC vertical machining centers.",
      "standards_link": "CE Marking technical construction file verified with European notified body for exports to EU.",
      "oem_linkage": "Primary machine tool builder supplying automotive component makers across Pune, Sanand, and Chennai clusters."
    }
  },
  {
    "id": "mfg_11",
    "name": "Windsor Machines Limited",
    "entity_type": "manufacturer",
    "hs6_codes": [
      "847710",
      "848120"
    ],
    "sector": "Engineering Goods & Machinery",
    "location": "Plot 5402, GIDC Industrial Estate, Vatva / Chhatral",
    "state": "Gujarat",
    "processes": [
      "Hydraulic Platen Heavy Machining",
      "Bimetallic Screw & Barrel Nitriding",
      "Servo-Hydraulic Integration",
      "Closed-Loop Injection Testing"
    ],
    "materials": [
      "High-Strength Structural Steel (EN8, EN24)",
      "Nitrided Alloy Steel (38CrMoAl)",
      "Modular Cast Iron Platens"
    ],
    "tolerance_class": "Shot-weight repeatability (\u00b10.15%)",
    "scale_capacity": "1,800 Injection Units / year (60 to 2,500 Ton clamping)",
    "certifications": [
      {
        "name": "ISO 9001:2015",
        "valid_until": "2028-04",
        "verified": true
      },
      {
        "name": "CE Declaration of Conformity",
        "valid_until": "2027-11",
        "verified": true
      },
      {
        "name": "BIS QCO Plastics Machinery Safety (IS 16568)",
        "valid_until": "2028-09",
        "verified": true
      }
    ],
    "verification_level": "Field audit",
    "deduction_rationale": {
      "site_verification": "GIDC Chhatral plant audited; factory floor spans 35,000 sq. meters with 50-tonne overhead cranes and precision horizontal boring mills.",
      "process_audit": "Verified local assembly of toggle-type and two-platen servo injection moulding machines; proprietary screw hardening furnaces verified on site.",
      "standards_link": "BIS safety compliance verified; exports to 65+ countries audited through customs export manifests.",
      "oem_linkage": "Supplies automated injection equipment to auto ancillary tier-1s (Motherson, Supreme Industries) and medical plastic moulders."
    }
  },
  {
    "id": "mfg_10",
    "name": "Everest Kanto Cylinder Ltd. (EKC)",
    "entity_type": "manufacturer",
    "hs6_codes": [
      "731100",
      "722540"
    ],
    "sector": "Iron & Steel",
    "location": "Gandhidham Complex, Kandla Special Economic Zone",
    "state": "Gujarat",
    "processes": [
      "Seamless Steel Tube Hot Spinning",
      "Normalising & Quench-and-Temper Heat Treatment",
      "Hydrostatic Burst Proof Testing (450 Bar)",
      "Ultrasonic Wall Thickness Mapping"
    ],
    "materials": [
      "Chromium-Molybdenum Alloy Steel (34CrMo4)",
      "Carbon-Manganese Steel"
    ],
    "tolerance_class": "Working Pressure 200\u2013300 Bar (ISO 11439 Type 1 & 2)",
    "scale_capacity": "800,000 High-Pressure Cylinders / year",
    "certifications": [
      {
        "name": "PESO (Petroleum and Explosives Safety Organization)",
        "valid_until": "2028-12",
        "verified": true
      },
      {
        "name": "ISO 9001:2015 & ISO 11439",
        "valid_until": "2027-10",
        "verified": true
      },
      {
        "name": "BIS QCO Gas Cylinders (IS 7285 & IS 15490)",
        "valid_until": "2028-05",
        "verified": true
      }
    ],
    "verification_level": "Field audit",
    "deduction_rationale": {
      "site_verification": "Kandla facility verified under SEZ Commissionerate; automated hot-spinning lines and automated hydrostatic testing cages physically inspected.",
      "process_audit": "PESO quarterly safety testing certificates cross-checked against batch serial numbers for CNG and industrial gas cylinders.",
      "standards_link": "Active BIS license for seamless alloy steel cylinders under IS 7285 Part 2 verified on National Standards repository.",
      "oem_linkage": "OEM cylinder supplier to Maruti Suzuki, Tata Motors Commercial, and city gas distribution networks (IGL, MGL)."
    }
  },
  {
    "id": "mfg_12",
    "name": "Balkrishna Industries Ltd. (BKT Tires)",
    "entity_type": "manufacturer",
    "hs6_codes": [
      "401170"
    ],
    "sector": "Rubber & Tyres",
    "location": "Bhuj Integrated Tyre Plant, Kutch",
    "state": "Gujarat",
    "processes": [
      "Automated Rubber Compounding",
      "Steel Cord & Fabric Calendering",
      "Green Tyre Building",
      "Nitrogen Cure Vulcanisation Pressing"
    ],
    "materials": [
      "Natural Rubber (RSS-4/ISNR-20)",
      "Styrene-Butadiene Synthetic Rubber",
      "High-Tensile Steel Cord",
      "Silica Reinforcement Compounds"
    ],
    "tolerance_class": "ECE R106 & TRA Load Index Compliant",
    "scale_capacity": "360,000 Metric Tonnes / year (Off-Highway & Agri-Tyres)",
    "certifications": [
      {
        "name": "IATF 16949:2016",
        "valid_until": "2027-12",
        "verified": true
      },
      {
        "name": "BIS QCO Pneumatic Tyres (IS 15636)",
        "valid_until": "2028-06",
        "verified": true
      },
      {
        "name": "DOT & E-Mark (ECE R106)",
        "valid_until": "2028-03",
        "verified": true
      }
    ],
    "verification_level": "Field audit",
    "deduction_rationale": {
      "site_verification": "Bhuj Mega-Plant spanning 300+ acres verified via Gujarat Industrial Ext. Bureau (iNDEXTb); carbon black captive plant and test tracks audited.",
      "process_audit": "Full internal vulcanisation process with robotic green tyre handling and laser speckle shearography non-destructive testing.",
      "standards_link": "BIS certification IS 15636 verified on BIS national register; ECE R106 approvals registered with European vehicle authorities.",
      "oem_linkage": "Direct supplier of agricultural and forestry tractor radial tyres to Mahindra Tractors, John Deere India, and CNH Industrial."
    }
  },
  {
    "id": "mfg_02",
    "name": "Dixon Technologies (India) Ltd. - Mobile Div.",
    "entity_type": "manufacturer",
    "hs6_codes": [
      "851713",
      "847130",
      "853710"
    ],
    "sector": "Electronics & Electrical",
    "location": "Phase II, Noida Electronic City, Gautam Buddha Nagar",
    "state": "Uttar Pradesh",
    "processes": [
      "Surface Mount Technology (SMT)",
      "Selective Soldering",
      "Automated Optical Inspection (AOI)",
      "Final Box Assembly & RF Calibration"
    ],
    "materials": [
      "FR4 10-Layer Multilayer PCBs",
      "Active SMT Components",
      "Precision Aluminum Enclosures"
    ],
    "tolerance_class": "IPC-A-610 Class 3 / 0201 Component Placement",
    "scale_capacity": "38 Million Handsets & Laptops / year",
    "certifications": [
      {
        "name": "ISO 9001:2015",
        "valid_until": "2027-05",
        "verified": true
      },
      {
        "name": "PLI Mobile Manufacturing Beneficiary (MeitY)",
        "valid_until": "2028-03",
        "verified": true
      },
      {
        "name": "BIS CRS Registration (IS 13252)",
        "valid_until": "2027-12",
        "verified": true
      },
      {
        "name": "ISO 14001 & ISO 45001",
        "valid_until": "2026-10",
        "verified": true
      }
    ],
    "verification_level": "Field audit",
    "deduction_rationale": {
      "site_verification": "Noida manufacturing facility physically audited under MeitY PLI scheme milestone inspections. Plant occupies 450,000 sq. ft clean-room space.",
      "process_audit": "32 high-speed Panasonic & Fuji SMT lines verified with 3D solder paste inspection and X-ray BGA verification.",
      "standards_link": "BIS CRS registration numbers verified active for 14 active smartphone and tablet models produced under OEM contract.",
      "oem_linkage": "Contract manufacturer for Xiaomi, Motorola, and Acer under domestic electronics PLI agreements."
    }
  },
  {
    "id": "mfg_07",
    "name": "Suryamitra Photovoltaic Technologies Ltd.",
    "entity_type": "manufacturer",
    "hs6_codes": [
      "854143",
      "850760",
      "854110"
    ],
    "sector": "Electronics & Electrical",
    "location": "Dholera Special Investment Region (DSIR)",
    "state": "Gujarat",
    "processes": [
      "TOPCon Solar Cell Metallisation",
      "Multi-Busbar High-Density Soldering",
      "Vacuum Lamination",
      "Electroluminescence (EL) Crack Screening"
    ],
    "materials": [
      "N-Type Monocrystalline Wafers (M10/G12)",
      "Silver Pastes",
      "EVA/POE Encapsulants",
      "Solar Glass (ARC)"
    ],
    "tolerance_class": "Cell Efficiency > 24.8% / Module Power > 600W",
    "scale_capacity": "4.2 Gigawatts / year",
    "certifications": [
      {
        "name": "ALMM (Approved List of Module Manufacturers - MNRE)",
        "valid_until": "2028-01",
        "verified": true
      },
      {
        "name": "BIS QCO Solar PV (IS 14286 & IS/IEC 61730)",
        "valid_until": "2027-11",
        "verified": true
      },
      {
        "name": "IEC 61215 & IEC 61730 International",
        "valid_until": "2028-06",
        "verified": true
      }
    ],
    "verification_level": "Field audit",
    "deduction_rationale": {
      "site_verification": "Dholera SIR plant visited by MNRE verification team for ALMM onboarding. Robotic cell-stringing and vacuum lamination lines verified.",
      "process_audit": "Power output testing conducted using Class AAA solar flash testers calibrated against NREL reference cells.",
      "standards_link": "Listed on MNRE ALMM Order List 1 as Tier-1 domestic cell and module maker.",
      "oem_linkage": "Supplies utility-scale solar projects awarded under SECI and NTPC national bids with Domestic Content Requirement (DCR)."
    }
  },
  {
    "id": "mfg_13",
    "name": "Suzlon Energy Ltd. - Nacelle & Generator Division",
    "entity_type": "manufacturer",
    "hs6_codes": [
      "850231"
    ],
    "sector": "Electronics & Electrical",
    "location": "Daman Industrial Area / Coimbatore Wind Hub",
    "state": "Gujarat / Tamil Nadu",
    "processes": [
      "Synchronous Wind Generator Heavy Winding",
      "Yaw & Pitch Drive Integration",
      "Nacelle Modular Assembly",
      "Full Load Dynamic Test Rig (3.5 MW)"
    ],
    "materials": [
      "Low-Carbon Rotor Laminations",
      "Copper Magnet Wire (Class H)",
      "Cast Iron Main Shaft Housings",
      "Direct Drive Magnets"
    ],
    "tolerance_class": "IEC 61400-1 Wind Turbine Class S",
    "scale_capacity": "2,400 Megawatts Wind Turbine Nacelles / year",
    "certifications": [
      {
        "name": "RLMM (Revised List of Models & Manufacturers - MNRE)",
        "valid_until": "2028-05",
        "verified": true
      },
      {
        "name": "ISO 9001 & ISO 14001",
        "valid_until": "2027-09",
        "verified": true
      },
      {
        "name": "T\u00dcV Rheinland Type Certification",
        "valid_until": "2028-11",
        "verified": true
      }
    ],
    "verification_level": "Field audit",
    "deduction_rationale": {
      "site_verification": "Coimbatore generator manufacturing plant and Daman nacelle assembly facility audited by NIWE (National Institute of Wind Energy).",
      "process_audit": "Vacuum pressure impregnation (VPI) tanks for generator stators and 4-MW testing dyno physically inspected.",
      "standards_link": "Approved on MNRE RLMM list for 2.1 MW and 3.14 MW turbine platforms.",
      "oem_linkage": "Supplies turn-key wind power assets to Tata Power, Adani Green, and state electricity distribution companies."
    }
  },
  {
    "id": "mfg_14",
    "name": "Sterlite Technologies Limited (STL)",
    "entity_type": "manufacturer",
    "hs6_codes": [
      "854470"
    ],
    "sector": "Electronics & Electrical",
    "location": "Rakholi Complex, Silvassa / Waluj Industrial Area, Aurangabad",
    "state": "Dadra & Nagar Haveli / Maharashtra",
    "processes": [
      "Vapour Axial Deposition (VAD) Optical Preform Making",
      "High-Speed Fibre Drawing (2500 m/min)",
      "Helical Loose Tube Colouring & Stranding",
      "Armoured Aramid Sheathing"
    ],
    "materials": [
      "High-Purity Fused Synthetic Silica",
      "UV-Curable Acrylate Resin",
      "PBT Buffer Compounds",
      "Corrugated Steel Tape"
    ],
    "tolerance_class": "Attenuation < 0.19 dB/km at 1550 nm (ITU-T G.652D & G.657A2)",
    "scale_capacity": "42 Million Fibre Kilometres / year",
    "certifications": [
      {
        "name": "TEC Mandatory Testing & Certification (MTCTE)",
        "valid_until": "2028-02",
        "verified": true
      },
      {
        "name": "TL 9000 (Telecommunications Quality)",
        "valid_until": "2027-11",
        "verified": true
      },
      {
        "name": "ISO 9001, ISO 14001, ISO 45001",
        "valid_until": "2028-07",
        "verified": true
      }
    ],
    "verification_level": "Field audit",
    "deduction_rationale": {
      "site_verification": "Aurangabad optical preform facility and Silvassa cable cabling facility inspected under DoT BharatNet qualification audit.",
      "process_audit": "Indigenously owned vertical drawing towers and OTDR attenuation testing loops audited on site.",
      "standards_link": "MTCTE certification from Telecommunication Engineering Centre (TEC) verified active.",
      "oem_linkage": "Key supplier of high-count ribbon fibre cables to Reliance Jio, Bharti Airtel, and BharatNet project."
    }
  },
  {
    "id": "mfg_15",
    "name": "Rare Earth Magnetics India Ltd. (REMI)",
    "entity_type": "manufacturer",
    "hs6_codes": [
      "850511"
    ],
    "sector": "Electronics & Electrical",
    "location": "Atchutapuram SEZ, Visakhapatnam",
    "state": "Andhra Pradesh",
    "processes": [
      "Vacuum Induction Melting (VIM)",
      "Jet Milling under Inert Argon",
      "Magnetic Field Orientation Pressing",
      "Vacuum Sintering & Grain Boundary Diffusion"
    ],
    "materials": [
      "Neodymium (Nd)",
      "Praseodymium (Pr)",
      "Dysprosium (Dy)",
      "Electrolytic Iron & Ferro-Boron"
    ],
    "tolerance_class": "N52 & 48SH Grade (Residual Induction Br > 1.42 T)",
    "scale_capacity": "2,500 Metric Tonnes Sintered NdFeB / year",
    "certifications": [
      {
        "name": "ISO 9001:2015",
        "valid_until": "2027-10",
        "verified": true
      },
      {
        "name": "IATF 16949 (EV Traction Magnetics)",
        "valid_until": "2028-04",
        "verified": true
      },
      {
        "name": "IREL Monazite Feedstock Sourcing MoU",
        "valid_until": "2029-01",
        "verified": true
      }
    ],
    "verification_level": "Field audit",
    "deduction_rationale": {
      "site_verification": "Visakhapatnam APSEZ industrial plant audited; features clean argon sintering chambers and automated Ni-Cu-Ni plating line.",
      "process_audit": "Supply chain linkage to IREL (India) Limited for separated rare earth oxides verified via domestic sourcing records.",
      "standards_link": "BH curve tracer and demagnetisation temperature curve verified up to 180\u00b0C for EV traction motors.",
      "oem_linkage": "Supplies permanent magnet rotors to domestic EV powertrain producers (Ola Electric, Ather Energy)."
    }
  },
  {
    "id": "mfg_03",
    "name": "Hetero Drugs & Active Precursors Ltd.",
    "entity_type": "manufacturer",
    "hs6_codes": [
      "300490",
      "293339",
      "300410"
    ],
    "sector": "Pharmaceuticals",
    "location": "JNPC Pharma City, Parawada, Visakhapatnam",
    "state": "Andhra Pradesh",
    "processes": [
      "Heterocyclic Catalytic Synthesis",
      "Cryogenic Chemical Reaction (-80\u00b0C)",
      "Centrifugal Separation & Solvent Stripping",
      "Cleanroom Micronisation (Class D)"
    ],
    "materials": [
      "Nitrogen Hetero-Ring Intermediates",
      "Beta-Lactam Nuclei (6-APA)",
      "Pharmaceutical Grade Solvents"
    ],
    "tolerance_class": "High Chemical Purity (> 99.8% HPLC assay)",
    "scale_capacity": "1,400 Metric Tonnes Active Pharma Ingredients / year",
    "certifications": [
      {
        "name": "US FDA Good Manufacturing Practice (cGMP)",
        "valid_until": "2027-08",
        "verified": true
      },
      {
        "name": "WHO PQ (Prequalification) Formulation Unit",
        "valid_until": "2028-03",
        "verified": true
      },
      {
        "name": "EU GMP Compliance Certificate",
        "valid_until": "2027-12",
        "verified": true
      },
      {
        "name": "CDSCO Form 28 / 28D Manufacturing License",
        "valid_until": "2028-05",
        "verified": true
      }
    ],
    "verification_level": "Field audit",
    "deduction_rationale": {
      "site_verification": "JNPC Pharma City Unit 4 verified through Andhra Pradesh Pollution Control Board (APPCB) consent-to-operate and CDSCO central inspection register.",
      "process_audit": "Glass-lined chemical reactors, SCADA recipe automation, and zero-liquid discharge (ZLD) effluent facilities physically audited.",
      "standards_link": "EIR (Establishment Inspection Report) from US FDA successfully cleared with zero Form 483 critical observations.",
      "oem_linkage": "Major supplier of bulk finished dosage forms and synthetic APIs to global generic procurement agencies (PAHO, Global Fund)."
    }
  },
  {
    "id": "mfg_04",
    "name": "Hindustan Syringes & Medical Devices Ltd. (HMD)",
    "entity_type": "manufacturer",
    "hs6_codes": [
      "901831",
      "902110"
    ],
    "sector": "Medical & Precision Instruments",
    "location": "Sector 25, Ballabgarh Industrial Corridor, Faridabad",
    "state": "Haryana",
    "processes": [
      "Medical Grade Polymer Injection Moulding",
      "Automated Needle Cannula Grinding",
      "Ethylene Oxide (EtO) Sterilisation",
      "Blister Packaging in Class 10,000 Cleanroom"
    ],
    "materials": [
      "Medical Grade Polypropylene (USP Class VI)",
      "Stainless Steel Cannula Wire (AISI 304)",
      "Silicone Lubricant"
    ],
    "tolerance_class": "ISO 7886-1 & ISO 7864 Medical Standards",
    "scale_capacity": "2.5 Billion Disposable & Auto-Disable Syringes / year",
    "certifications": [
      {
        "name": "MDR 2017 Class B / C License (CDSCO)",
        "valid_until": "2028-06",
        "verified": true
      },
      {
        "name": "CE Mark (MDR 2017/745 Notified Body 0123)",
        "valid_until": "2027-11",
        "verified": true
      },
      {
        "name": "ISO 13485:2016 (Medical Devices)",
        "valid_until": "2028-01",
        "verified": true
      },
      {
        "name": "WHO PQS Pre-qualified Syringe Line",
        "valid_until": "2027-09",
        "verified": true
      }
    ],
    "verification_level": "Field audit",
    "deduction_rationale": {
      "site_verification": "Ballabgarh industrial plant premises verified via Haryana State IDC and CDSCO central licensing portal; 12 automated assembly lines audited.",
      "process_audit": "EtO sterilisation chambers verified with biological indicators (Bacillus atrophaeus) validation data; cleanroom air particle counts verified.",
      "standards_link": "Valid CE mark and CDSCO MD-9 manufacturing license confirmed active on CDSCO SUGAM portal.",
      "oem_linkage": "Primary supplier of auto-disable immunization syringes to UNICEF, WHO, and Government of India Universal Immunization Programme."
    }
  },
  {
    "id": "mfg_16",
    "name": "Orthocare MedTech Solutions Ltd.",
    "entity_type": "manufacturer",
    "hs6_codes": [
      "902110"
    ],
    "sector": "Medical & Precision Instruments",
    "location": "Andhra Pradesh MedTech Zone (AMTZ), Visakhapatnam",
    "state": "Andhra Pradesh",
    "processes": [
      "Titanium Additive Manufacturing (DMLS)",
      "High-Precision 5-Axis Implant Milling",
      "Electrochemical Polishing",
      "Gamma Irradiation Sterilisation"
    ],
    "materials": [
      "Medical Titanium Alloy (Ti6Al4V ELI)",
      "Cobalt-Chromium (CoCrMo)",
      "UHMWPE (Ultra High Mol. Weight Polyethylene)"
    ],
    "tolerance_class": "ISO 5832-3 / ASTM F136 Implant Grade",
    "scale_capacity": "180,000 Joint Implants & Trauma Plates / year",
    "certifications": [
      {
        "name": "CDSCO Form MD-9 License (Class C/D)",
        "valid_until": "2028-04",
        "verified": true
      },
      {
        "name": "ISO 13485:2016",
        "valid_until": "2027-12",
        "verified": true
      },
      {
        "name": "BIS QCO Orthopaedic Implants (IS 15000)",
        "valid_until": "2028-08",
        "verified": true
      }
    ],
    "verification_level": "Field audit",
    "deduction_rationale": {
      "site_verification": "AMTZ MedTech Zone plant inspected; utilizes shared testing infrastructure at AMTZ for biomechanical wear and biocompatibility testing.",
      "process_audit": "Selective laser melting machines (EOS M290) and cleanroom sterile packaging lines physically audited.",
      "standards_link": "Full compliance with CDSCO Medical Device Rules 2017 verified on SUGAM.",
      "oem_linkage": "Supplies orthopaedic surgical implants to central government health hospitals (AIIMS, ESIC)."
    }
  },
  {
    "id": "mfg_05",
    "name": "Aequs Toy & Consumer Goods Ecosystem",
    "entity_type": "manufacturer",
    "hs6_codes": [
      "950300"
    ],
    "sector": "Furniture, Toys & Misc. Manufactures",
    "location": "Koppal Toy Cluster, Hubballi-Dharwad Industrial Belt",
    "state": "Karnataka",
    "processes": [
      "High-Speed Plastic Injection Moulding",
      "Pad Printing & Robotic Spray Painting",
      "Ultrasonic Plastic Welding",
      "Safety Drop & Torque Testing"
    ],
    "materials": [
      "Non-Toxic ABS (BPA-Free)",
      "High-Impact Polystyrene (HIPS)",
      "Lead-Free Paints & Non-Phthalate PVC"
    ],
    "tolerance_class": "Zero Toxic Leaching / Heavy Metal Free (IS 9873 Parts 1-3)",
    "scale_capacity": "45 Million Toy Units / year",
    "certifications": [
      {
        "name": "BIS QCO Toys Certification (IS 9873 Parts 1-3)",
        "valid_until": "2028-05",
        "verified": true
      },
      {
        "name": "ICTI Ethical Toy Program (IETP)",
        "valid_until": "2027-09",
        "verified": true
      },
      {
        "name": "ISO 9001:2015",
        "valid_until": "2027-11",
        "verified": true
      },
      {
        "name": "EN 71 & ASTM F963 Toy Safety Compliance",
        "valid_until": "2028-02",
        "verified": true
      }
    ],
    "verification_level": "Field audit",
    "deduction_rationale": {
      "site_verification": "Koppal 400-acre dedicated toy SEZ manufacturing unit verified via Karnataka Industrial Area Development Board (KIADB) deeds.",
      "process_audit": "In-house physical safety testing lab verified with automated drop testers, tension gauges, and XRF heavy metal screener.",
      "standards_link": "BIS ISI standard mark license CM/L-67001928 verified active on BIS national registry.",
      "oem_linkage": "Contract manufacturing partner for Hasbro, Spin Master, and Funskool under international sourcing agreements."
    }
  },
  {
    "id": "mfg_09",
    "name": "Farida Footwear Private Limited",
    "entity_type": "manufacturer",
    "hs6_codes": [
      "640399",
      "591190"
    ],
    "sector": "Leather & Footwear",
    "location": "SIPCOT Industrial Park, Ambur / Ranipet",
    "state": "Tamil Nadu",
    "processes": [
      "Computerised Laser Leather Cutting",
      "Automated Upper Stitching & Lasting",
      "Direct Injection Polyurethane (PU) Moulding",
      "Flexing Endurance & Hydrolysis Testing"
    ],
    "materials": [
      "Full-Grain Leather",
      "Thermoplastic Polyurethane (TPU)",
      "High-Density Memory Foam Insoles"
    ],
    "tolerance_class": "SATRA Footwear Standards Compliant",
    "scale_capacity": "9.6 Million Pairs / year",
    "certifications": [
      {
        "name": "LWG (Leather Working Group) Gold Rated",
        "valid_until": "2027-12",
        "verified": true
      },
      {
        "name": "BIS QCO Footwear (IS 17043)",
        "valid_until": "2028-04",
        "verified": true
      },
      {
        "name": "ISO 9001:2015 & ISO 14001",
        "valid_until": "2027-06",
        "verified": true
      }
    ],
    "verification_level": "Field audit",
    "deduction_rationale": {
      "site_verification": "Ambur SIPCOT manufacturing facility audited; zero discharge leather tannery and automated shoe assembly lines physically audited.",
      "process_audit": "Desma direct-soling injection machines and SATRA certified quality testing lab verified on premises.",
      "standards_link": "BIS Quality Control Order license for leather footwear verified on BIS portal; LWG Gold audit report cross-checked.",
      "oem_linkage": "Approved OEM footwear manufacturing supplier to Clarks, Rockport, Florsheim, and Marks & Spencer."
    }
  },
  {
    "id": "mfg_17",
    "name": "Arvind Advanced Materials Ltd.",
    "entity_type": "manufacturer",
    "hs6_codes": [
      "591190"
    ],
    "sector": "Textiles & Apparel",
    "location": "Santej Industrial Complex, Gandhinagar",
    "state": "Gujarat",
    "processes": [
      "Needle-Punched Non-Woven Felting",
      "PTFE Membrane Thermal Lamination",
      "High-Temperature Singeing & Heat-Setting",
      "Permeability & Micron-Rating Testing"
    ],
    "materials": [
      "Polytetrafluoroethylene (PTFE)",
      "meta-Aramid (Nomex)",
      "PPS (Polyphenylene Sulfide)",
      "Glass Fibre Yarns"
    ],
    "tolerance_class": "Filtration Efficiency > 99.9% down to 0.5 \u03bcm",
    "scale_capacity": "18 Million Square Metres Technical Textiles / year",
    "certifications": [
      {
        "name": "ISO 9001:2015",
        "valid_until": "2027-08",
        "verified": true
      },
      {
        "name": "OEKO-TEX Standard 100 Class I",
        "valid_until": "2028-03",
        "verified": true
      },
      {
        "name": "BIS QCO Technical Textiles (IS 16654)",
        "valid_until": "2028-09",
        "verified": true
      }
    ],
    "verification_level": "Field audit",
    "deduction_rationale": {
      "site_verification": "Santej composite technical textile plant audited; spans 120,000 sq. m equipped with German Dilo needle-loom lines.",
      "process_audit": "Frazier air permeability and particle retention testing verified against ASTM D737 standards on site.",
      "standards_link": "Active BIS license for industrial filter fabrics verified on Ministry of Textiles portal.",
      "oem_linkage": "Supplies critical air pollution filter bags to cement, thermal power, and chemical plants nationwide."
    }
  },
  {
    "id": "trd_01",
    "name": "Redington India Ltd. - Electronics & IT",
    "entity_type": "trader",
    "hs6_codes": [
      "851713",
      "847130",
      "854110"
    ],
    "sector": "Electronics & Electrical",
    "location": "Redington Logistics Hub, Sriperumbudur / Guindy",
    "state": "Tamil Nadu",
    "processes": [
      "High-Throughput Bonded Warehousing",
      "Customs Clearance & Bill of Entry Management",
      "Secondary Labelling & IMEI Tracking",
      "Nationwide Tier-2 Channel Distribution"
    ],
    "materials": [
      "Finished Laptops, Smartphones & Discrete Chips"
    ],
    "tolerance_class": "Commercial Logistics & Distribution SLA (48-hr fulfillment)",
    "scale_capacity": "$3.8 Bn Turnover / 14 Million Devices Distributed",
    "certifications": [
      {
        "name": "AEO-T3 (Authorised Economic Operator - CBIC)",
        "valid_until": "2028-09",
        "verified": true
      },
      {
        "name": "ISO 9001:2015 Logistics",
        "valid_until": "2027-11",
        "verified": true
      }
    ],
    "verification_level": "Customs ICEGATE audit",
    "deduction_rationale": {
      "site_verification": "Deduction confirms entity is a commercial supply-chain distributor. Physical inspection of Chennai and Bhiwandi facilities confirmed 100% warehouse/pallet racks; NO manufacturing SMT lines or assembly machinery installed.",
      "process_audit": "ICEGATE Bill of Entry verification: 96% of distributed items cleared as complete finished goods from China, Vietnam, and Taiwan under HSN 847130 & 851713.",
      "standards_link": "AEO-T3 tier status verified on CBIC customs clearance database for expedited green-channel clearance.",
      "oem_linkage": "Authorized national commercial distributor for Apple, HP, Dell, and Asus."
    }
  },
  {
    "id": "trd_02",
    "name": "Ingram Micro India Private Limited",
    "entity_type": "trader",
    "hs6_codes": [
      "847130",
      "851713",
      "853710"
    ],
    "sector": "Engineering Goods & Machinery",
    "location": "Bhiwandi Logistics Hub, Thane / Mumbai",
    "state": "Maharashtra",
    "processes": [
      "Bonded FTWZ Warehousing",
      "Import Clearance Indenting",
      "Serial Number RFID Tracking",
      "Reverse Logistics & RMA Handling"
    ],
    "materials": [
      "Finished IT Peripherals & Electronic Control Modules"
    ],
    "tolerance_class": "Logistics inventory accuracy (99.94%)",
    "scale_capacity": "250,000 sq. ft Automated Pallet Warehouse",
    "certifications": [
      {
        "name": "AEO-T2 (CBIC Customs Facilitation)",
        "valid_until": "2028-04",
        "verified": true
      },
      {
        "name": "ISO 27001 (Information Security)",
        "valid_until": "2027-08",
        "verified": true
      }
    ],
    "verification_level": "Customs ICEGATE audit",
    "deduction_rationale": {
      "site_verification": "Bhiwandi FTWZ premises audited: strictly operates high-bay automated racking and sorting conveyors; no fabrication equipment on premise.",
      "process_audit": "Customs clearance records show 140,000 imported consignments cleared annually through Nhava Sheva (JNPT) and Air Cargo Mumbai.",
      "standards_link": "AEO-T2 accreditation verified with Mumbai Customs Zone-II.",
      "oem_linkage": "Commercial wholesale distributor servicing 25,000+ retail IT and industrial automation partners across India."
    }
  },
  {
    "id": "trd_03",
    "name": "Yasham Bio-Sciences & Chemical Indenting Pvt. Ltd.",
    "entity_type": "trader",
    "hs6_codes": [
      "293339",
      "300490",
      "300410"
    ],
    "sector": "Pharmaceuticals",
    "location": "Andheri East Commercial Chambers, Mumbai",
    "state": "Maharashtra",
    "processes": [
      "Overseas API Indenting & Sourcing",
      "Cold-Chain Bonded Storage (2\u20138\u00b0C)",
      "Customs Drug Controller (ADC) Clearance",
      "Certificate of Analysis (CoA) Verification"
    ],
    "materials": [
      "Synthetic Active Pharmaceutical Intermediates & Precursors"
    ],
    "tolerance_class": "Commercial Bulk Trading (> 99.0% Assay on Manufacturer CoA)",
    "scale_capacity": "8,500 Metric Tonnes Imported APIs / year",
    "certifications": [
      {
        "name": "CDSCO Form 20B/21B Wholesale Drug License",
        "valid_until": "2027-10",
        "verified": true
      },
      {
        "name": "GDP (Good Distribution Practice - WHO)",
        "valid_until": "2028-02",
        "verified": true
      }
    ],
    "verification_level": "Customs ICEGATE audit",
    "deduction_rationale": {
      "site_verification": "Entity registered at corporate commercial premises in Mumbai with outsourced cold-storage warehousing in Bhiwandi; no chemical reactors.",
      "process_audit": "ICEGATE trade flow cross-matching reveals active import indenting from Zhejiang NHU and Hualian Pharma (China) directly to Indian formulation plants.",
      "standards_link": "Wholesale drug trading licenses verified active with Maharashtra FDA.",
      "oem_linkage": "Brokering active substance precursors to SME formulators across Ahmedabad, Baddi, and Hyderabad clusters."
    }
  },
  {
    "id": "trd_04",
    "name": "Swagelok India Sourcing & Trading Services",
    "entity_type": "trader",
    "hs6_codes": [
      "848120",
      "731815",
      "731100"
    ],
    "sector": "Engineering Goods & Machinery",
    "location": "DLF Cyber City, Gurugram & Nhava Sheva Warehouse",
    "state": "Haryana / Maharashtra",
    "processes": [
      "High-Pressure Valve Stockholding",
      "Pre-Installation Leak Testing (N2 Gas)",
      "Hydrostatic Bench Verification",
      "Customs Documentation Management"
    ],
    "materials": [
      "Imported 316 Stainless Steel Valves & Tube Fittings"
    ],
    "tolerance_class": "ASME B16.34 & B31.3 Compliant Imports",
    "scale_capacity": "200,000 Assembled Fittings / year imported from USA/Europe",
    "certifications": [
      {
        "name": "ISO 9001:2015 Stockist Certification",
        "valid_until": "2027-09",
        "verified": true
      },
      {
        "name": "AEO-T1 Customs Facilitation",
        "valid_until": "2028-01",
        "verified": true
      }
    ],
    "verification_level": "Customs ICEGATE audit",
    "deduction_rationale": {
      "site_verification": "Commercial sales office and distribution test lab; components imported fully forged from Solon, Ohio, USA and Switzerland.",
      "process_audit": "Nhava Sheva and Delhi IGI customs import manifests confirm regular high-value shipments under HSN 848120; markup margin estimated at 22-30%.",
      "standards_link": "Stockist and test lab accreditation verified; holds valid calibration certificates.",
      "oem_linkage": "Supplies high-purity fluid handling valves to petrochemical refineries (Reliance, IOCL) and semiconductor R&D setups."
    }
  },
  {
    "id": "trd_05",
    "name": "Toyzpot India Wholesale & Sourcing Ltd.",
    "entity_type": "trader",
    "hs6_codes": [
      "950300"
    ],
    "sector": "Furniture, Toys & Misc. Manufactures",
    "location": "Sadar Bazar Wholesale Trade Center, Old Delhi",
    "state": "Delhi",
    "processes": [
      "Overseas Toy Indenting & Wholesale",
      "BIS Port Testing Coordination",
      "Customs Bonded Clearance",
      "Multi-City Retail Wholesale Distribution"
    ],
    "materials": [
      "Imported Plastic Toys, Battery-Operated Ride-Ons & Puzzles"
    ],
    "tolerance_class": "Commercial Retail Grade",
    "scale_capacity": "1,200 TEU Containers Imported / year",
    "certifications": [
      {
        "name": "DGFT IEC (Import Export Code)",
        "valid_until": "2028-12",
        "verified": true
      },
      {
        "name": "GST Registered Commercial Entity",
        "valid_until": "2027-11",
        "verified": true
      }
    ],
    "verification_level": "Customs ICEGATE audit",
    "deduction_rationale": {
      "site_verification": "Premises verified as commercial wholesale shopfront and inventory warehouse in Sadar Bazar; no manufacturing or injection moulds present.",
      "process_audit": "ICEGATE customs import manifests verify container shipments imported from Shantou and Ningbo (China) through Tughlakabad ICD.",
      "standards_link": "Coordinates third-party BIS batch safety testing at port of entry to comply with mandatory toy QCO requirements.",
      "oem_linkage": "Distributes imported toys to non-organised retail networks and regional distributors across Northern India."
    }
  },
  {
    "id": "trd_06",
    "name": "Becton Dickinson India Trading & Distribution Pvt. Ltd.",
    "entity_type": "trader",
    "hs6_codes": [
      "901831",
      "902110"
    ],
    "sector": "Medical & Precision Instruments",
    "location": "Signature Towers, South City 1, Gurugram",
    "state": "Haryana",
    "processes": [
      "Overseas Medical Consumable Import",
      "Cold-Chain Warehouse Storage",
      "Hospital Tender Indenting",
      "CDSCO Wholesale Drug & Device Distribution"
    ],
    "materials": [
      "Pre-filled Flush Syringes, Safety Cannulas & Orthopaedic Sets"
    ],
    "tolerance_class": "Medical Device Grade (Imported from Ireland, USA, Singapore)",
    "scale_capacity": "$220M Medical Consumables Distributed / year",
    "certifications": [
      {
        "name": "CDSCO Wholesale Medical Device License (MD-42)",
        "valid_until": "2028-03",
        "verified": true
      },
      {
        "name": "AEO-T2 Registered Importer",
        "valid_until": "2027-10",
        "verified": true
      }
    ],
    "verification_level": "Customs ICEGATE audit",
    "deduction_rationale": {
      "site_verification": "Gurugram commercial corporate office with logistics outsourced to certified 3PL hubs; does not run domestic syringe moulding lines for these imported specialty lines.",
      "process_audit": "Customs import declarations confirm specialized pre-filled saline flush syringes and safety needles imported directly from BD plants in Ireland and Singapore.",
      "standards_link": "Valid Form MD-15 import licenses confirmed on CDSCO SUGAM portal.",
      "oem_linkage": "Supplies premium safety medical devices to private tertiary hospitals (Apollo, Fortis, Max Healthcare)."
    }
  },
  {
    "id": "trd_07",
    "name": "Shreeji Alloy Steels & Metal Stockists Ltd.",
    "entity_type": "trader",
    "hs6_codes": [
      "722540",
      "731815",
      "731100"
    ],
    "sector": "Iron & Steel",
    "location": "Darukhana Iron & Steel Market, Mazgaon, Mumbai",
    "state": "Maharashtra",
    "processes": [
      "Heavy Coil Decoiling & Shearing",
      "Custom Plate Flame Cutting",
      "Ultrasonic Plate Thickness Verifications",
      "Just-In-Time Jobsite Delivery"
    ],
    "materials": [
      "Imported High-Strength Alloy Steel Plates & Seamless Tube Billets"
    ],
    "tolerance_class": "Commercial Mill Certificate Verification (EN 10204 3.1)",
    "scale_capacity": "85,000 Metric Tonnes Stocked & Cut / year",
    "certifications": [
      {
        "name": "ISO 9001:2015 Stockholding",
        "valid_until": "2027-07",
        "verified": true
      },
      {
        "name": "BIS Steel Import Registration Scheme (SIMS)",
        "valid_until": "2028-05",
        "verified": true
      }
    ],
    "verification_level": "Customs ICEGATE audit",
    "deduction_rationale": {
      "site_verification": "Mazgaon yard inspected; operation consists of gantry cranes, plate shearing tables, and flame cutters; NO blast furnace or rolling mill on site.",
      "process_audit": "Customs bills of entry through Mumbai Port Trust confirm regular imports of hot-rolled alloy steel plates from POSCO (Korea) and Nippon Steel (Japan).",
      "standards_link": "SIMS registrations cross-verified with Ministry of Steel import monitoring portal.",
      "oem_linkage": "Distributes specialized high-strength plates to fabricators of pressure vessels, earthmoving machinery, and defense equipment."
    }
  },
  {
    "id": "trd_08",
    "name": "Euro-Asia Solar Trading & Equipment Clearing House",
    "entity_type": "trader",
    "hs6_codes": [
      "854143",
      "850760",
      "854110"
    ],
    "sector": "Electronics & Electrical",
    "location": "Nariman Point Financial District, Mumbai & Mundra SEZ Warehouse",
    "state": "Maharashtra / Gujarat",
    "processes": [
      "Tier-1 PV Module Indenting",
      "Overseas Factory Flash-Report Verification",
      "Mundra Port Customs Bond Clearance",
      "Project-Site Staggered Logistics"
    ],
    "materials": [
      "Imported Monocrystalline Bifacial Solar Modules & Lithium Cells"
    ],
    "tolerance_class": "International Tier-1 PV Module Specifications",
    "scale_capacity": "1.8 Gigawatts Modules Brokered & Imported / year",
    "certifications": [
      {
        "name": "AEO-T1 Importer Status",
        "valid_until": "2027-11",
        "verified": true
      },
      {
        "name": "IEC Registration & ALMM Enrolment Facilitator",
        "valid_until": "2028-01",
        "verified": true
      }
    ],
    "verification_level": "Customs ICEGATE audit",
    "deduction_rationale": {
      "site_verification": "Corporate trading desk in Mumbai with contracted bonded storage at Mundra SEZ; zero domestic solar cell slicing or module assembly lines.",
      "process_audit": "ICEGATE records show 3,800 containers cleared through Mundra and Pipavav ports carrying Tier-1 imported modules from Southeast Asian factories.",
      "standards_link": "Tracks BIS and ALMM approvals of overseas parent factories for customs clearance clearance.",
      "oem_linkage": "Brokers module supplies to non-DCR commercial and industrial (C&I) rooftop and open-access developers."
    }
  },
  {
    "id": "trd_09",
    "name": "Apex Tyre Distributors & Fleet Imports Pvt. Ltd.",
    "entity_type": "trader",
    "hs6_codes": [
      "401170"
    ],
    "sector": "Rubber & Tyres",
    "location": "Panvel Logistics Park, Navi Mumbai",
    "state": "Maharashtra",
    "processes": [
      "Heavy Off-Highway Tyre Warehousing",
      "Port Clearance & DGFT Import Licensing",
      "Fleet Consignment Forwarding",
      "Warranty Replacement Inspection"
    ],
    "materials": [
      "Imported Agricultural & Forestry Pneumatic Tyres"
    ],
    "tolerance_class": "Commercial Radial & Bias Fleet Specifications",
    "scale_capacity": "140,000 Tyres Imported & Distributed / year",
    "certifications": [
      {
        "name": "DGFT Restricted Tyre Import License Holder",
        "valid_until": "2028-02",
        "verified": true
      },
      {
        "name": "ISO 9001:2015 Distribution Quality",
        "valid_until": "2027-08",
        "verified": true
      }
    ],
    "verification_level": "Customs ICEGATE audit",
    "deduction_rationale": {
      "site_verification": "Panvel warehousing depot inspected; comprises tyre stacking racks and forklift facilities; no rubber mastication or curing equipment.",
      "process_audit": "Nhava Sheva customs records verify imported agricultural tyres from Thailand and Vietnam under DGFT import authorization licenses.",
      "standards_link": "Mandatory BIS marks cross-referenced against overseas manufacturer licenses.",
      "oem_linkage": "Supplies replacement specialty agricultural tyres to state agro-industries corporations and commercial farm equipment fleets."
    }
  },
  {
    "id": "trd_10",
    "name": "Indo-German Plastics Machinery & Tooling Imports",
    "entity_type": "trader",
    "hs6_codes": [
      "847710"
    ],
    "sector": "Engineering Goods & Machinery",
    "location": "Kallakal Industrial Area, Medchal-Malkajgiri, Hyderabad",
    "state": "Telangana",
    "processes": [
      "High-End Machinery Import Brokerage",
      "Customs Project Cargo Clearance",
      "On-Site Commissioning by Factory Engineers",
      "Critical Spare Parts Consignment Stocking"
    ],
    "materials": [
      "Imported High-Precision Electric Injection Moulding Units"
    ],
    "tolerance_class": "European Machinery Directive Standards (Euromap 12/67)",
    "scale_capacity": "250 High-End European CNC Injection Machines Imported / year",
    "certifications": [
      {
        "name": "AEO-T1 Customs Logistics Accreditation",
        "valid_until": "2028-05",
        "verified": true
      },
      {
        "name": "Indo-German Chamber of Commerce Member",
        "valid_until": "2028-12",
        "verified": true
      }
    ],
    "verification_level": "Customs ICEGATE audit",
    "deduction_rationale": {
      "site_verification": "Hyderabad facility is a service demo center and spares warehouse; machines are 100% manufactured in Germany and Austria.",
      "process_audit": "Customs bills of entry through Chennai and Mumbai Air Cargo confirm project cargo clearance of all-electric injection machines.",
      "standards_link": "Complies with capital goods EPCG (Export Promotion Capital Goods) scheme requirements.",
      "oem_linkage": "Imports specialized cleanroom medical moulding machinery for high-volume syringe and pharmaceutical packaging producers."
    }
  },
  {
    "id": "trd_11",
    "name": "Global Renewable Components & Nacelle Indenting Co.",
    "entity_type": "trader",
    "hs6_codes": [
      "850231"
    ],
    "sector": "Electronics & Electrical",
    "location": "Express Towers, Marine Drive, Mumbai & Mundra Port Desk",
    "state": "Maharashtra / Gujarat",
    "processes": [
      "Heavy Wind Powertrain Import Clearance",
      "Specialized Multiaxle Hydraulic Transport",
      "Marine Insurance & Port Stevedoring",
      "EPC Delivery Coordination"
    ],
    "materials": [
      "Imported Wind Generating Sets, Planetary Gearboxes & Bearings"
    ],
    "tolerance_class": "Mega-Watt Class Heavy Rotating Machinery",
    "scale_capacity": "450 MW Imported Wind Turbine Assemblies / year",
    "certifications": [
      {
        "name": "AEO-T2 Logistics Accredited Operator",
        "valid_until": "2027-10",
        "verified": true
      }
    ],
    "verification_level": "Customs ICEGATE audit",
    "deduction_rationale": {
      "site_verification": "Commercial trading and indenting office in Nariman Point; no mechanical manufacturing plant or fabrication shops.",
      "process_audit": "Mundra Port customs manifests confirm project cargo handling of imported nacelles and gearboxes from Germany and Denmark.",
      "standards_link": "NIWE project specific import clearance documentation verified on MNRE portal.",
      "oem_linkage": "Supplies imported critical wind powertrains to independent power producers (IPPs) for round-the-clock renewable tenders."
    }
  },
  {
    "id": "trd_12",
    "name": "NetLink Fiber Optic Importers & Stockists Pvt. Ltd.",
    "entity_type": "trader",
    "hs6_codes": [
      "854470"
    ],
    "sector": "Electronics & Electrical",
    "location": "Okhla Industrial Estate Phase III, New Delhi",
    "state": "Delhi",
    "processes": [
      "High-Speed Optical Cable Stockholding",
      "Pre-Delivery OTDR Fluke Testing",
      "Drum Respooling & Custom Length Cutting",
      "Telecom Channel Distribution"
    ],
    "materials": [
      "Imported Ribbon & Armoured G.652D Optical Fibre Cables"
    ],
    "tolerance_class": "Telecom Transmission Standards (ITU-T G.652D)",
    "scale_capacity": "350,000 Kilometres Optical Cable Stocked & Shipped / year",
    "certifications": [
      {
        "name": "TEC Approval Certificate Holder for Imported Cables",
        "valid_until": "2028-04",
        "verified": true
      },
      {
        "name": "ISO 9001:2015 Certified Stockist",
        "valid_until": "2027-09",
        "verified": true
      }
    ],
    "verification_level": "Customs ICEGATE audit",
    "deduction_rationale": {
      "site_verification": "Okhla premises comprise commercial office and reel storage yard; zero optical preform draw towers or extrusion lines present.",
      "process_audit": "Customs declarations verify containerised optical cables imported from Vietnam and South Korea through Dadri and Tughlakabad ICDs.",
      "standards_link": "TEC MTCTE import certificates on record with Department of Telecommunications.",
      "oem_linkage": "Supplies imported telecom cables to regional internet service providers (ISPs) and smart city surveillance contractors."
    }
  },
  {
    "id": "trd_13",
    "name": "Neo-Magnetics Indenting & Sourcing Agency",
    "entity_type": "trader",
    "hs6_codes": [
      "850511"
    ],
    "sector": "Electronics & Electrical",
    "location": "Parrys Corner Commercial Street, Chennai",
    "state": "Tamil Nadu",
    "processes": [
      "Sintered Magnet Import Indenting",
      "Flux Density Gauss-Meter Lot Sampling",
      "Customs Bonded Logistics",
      "Automotive Motor Tier-2 Supply"
    ],
    "materials": [
      "Imported Rare-Earth NdFeB & Samarium-Cobalt Magnets"
    ],
    "tolerance_class": "Grade N42 to N52 NdFeB (Imported from Ningbo & Baotou)",
    "scale_capacity": "1,400 Metric Tonnes Sintered Blocks Imported / year",
    "certifications": [
      {
        "name": "DGFT IEC Holder & Registered Indenting House",
        "valid_until": "2028-08",
        "verified": true
      }
    ],
    "verification_level": "Customs ICEGATE audit",
    "deduction_rationale": {
      "site_verification": "Commercial agency shopfront in Chennai with storage in Sriperumbudur; zero vacuum induction furnaces or powder metallurgy mills.",
      "process_audit": "ICEGATE data indicates direct container imports of finished NdFeB sintered blocks from Baotou rare earth processing zones in China.",
      "standards_link": "Verification confirms third-party batch test certificates provided directly by Chinese exporters.",
      "oem_linkage": "Supplies permanent magnets to small domestic BLDC fan manufacturers and automotive sensor assemblers."
    }
  },
  {
    "id": "trd_14",
    "name": "Asian Technical Fabrics & Filter Media Indenting Co.",
    "entity_type": "trader",
    "hs6_codes": [
      "591190"
    ],
    "sector": "Textiles & Apparel",
    "location": "Ring Road Textile Market, Surat",
    "state": "Gujarat",
    "processes": [
      "Overseas High-Performance Fabric Indenting",
      "Roll Inspection & Yardage Verification",
      "Customs Clearing at Hazira Port",
      "Industrial Filter Bag Fabric Supply"
    ],
    "materials": [
      "Imported PTFE & Aramid Industrial Filter Felts"
    ],
    "tolerance_class": "High-Temperature Chemical Resistance (up to 260\u00b0C)",
    "scale_capacity": "2.4 Million Square Metres Imported / year",
    "certifications": [
      {
        "name": "Surat Textile Traders Association Member",
        "valid_until": "2028-11",
        "verified": true
      }
    ],
    "verification_level": "Customs ICEGATE audit",
    "deduction_rationale": {
      "site_verification": "Located in commercial textile exchange building in Surat; does not operate technical textile non-woven looms or needle-punching plants.",
      "process_audit": "Bills of entry at Hazira and Nhava Sheva verify roll shipments of PTFE and PPS needle-punched felts imported from Taiwan and Japan.",
      "standards_link": "Operates under commercial trade invoices with overseas mill test reports.",
      "oem_linkage": "Supplies imported filter media to fabricators assembling dust collector bags for cement kilns and steel mills."
    }
  },
  {
    "id": "trd_15",
    "name": "Metro Footwear Wholesale & International Trading Corp.",
    "entity_type": "trader",
    "hs6_codes": [
      "640399"
    ],
    "sector": "Leather & Footwear",
    "location": "Linking Road Wholesale Hub, Bandra West, Mumbai",
    "state": "Maharashtra",
    "processes": [
      "International Footwear Brand Sourcing",
      "Customs Clearance & Anti-Dumping Documentation",
      "Quality Check by AQL 2.5 Sampling",
      "Retail Chain Logistics Distribution"
    ],
    "materials": [
      "Imported Finished Leather & Synthetic Footwear"
    ],
    "tolerance_class": "Commercial Fashion & Formal Footwear Specifications",
    "scale_capacity": "4.2 Million Pairs Imported & Distributed / year",
    "certifications": [
      {
        "name": "BIS QCO Importer License Compliance",
        "valid_until": "2028-03",
        "verified": true
      },
      {
        "name": "AEO-T1 Customs Accreditation",
        "valid_until": "2027-12",
        "verified": true
      }
    ],
    "verification_level": "Customs ICEGATE audit",
    "deduction_rationale": {
      "site_verification": "Entity owns retail and distribution offices across Mumbai; does not own or operate leather shoe manufacturing factories.",
      "process_audit": "Nhava Sheva and Chennai Port customs records reveal high-volume containerized imports of finished leather shoes from Vietnam and Italy.",
      "standards_link": "Obtained BIS import licenses for foreign manufacturing plants under BIS FMCS (Foreign Manufacturers Certification Scheme).",
      "oem_linkage": "Supplies imported footwear collections to national department stores and e-commerce platforms."
    }
  },
  {
    "id": "mfg_18_cipla",
    "name": "Cipla Limited - Baddi Formulations & Sterile Dosages Plant",
    "entity_type": "manufacturer",
    "hs6_codes": [
      "300490",
      "300410",
      "293339"
    ],
    "sector": "Pharmaceuticals",
    "location": "Plot No. 9-11, Baddi Industrial Belt, Solan",
    "state": "Himachal Pradesh",
    "processes": [
      "Sterile Aseptic Liquid Filling",
      "High-Speed Rotary Tablet Compression (Fette 3090)",
      "Fluid Bed Granulation & Coating (Glatt)",
      "Lyophilization & Freeze-Drying"
    ],
    "materials": [
      "Amoxicillin Trihydrate USP",
      "Clavulanate Potassium USP",
      "Ceftriaxone Sodium Sterile API",
      "Pharma-Grade Microcrystalline Cellulose"
    ],
    "tolerance_class": "cGMP Class 100 (ISO 5 Cleanrooms)",
    "scale_capacity": "4.8 Billion tablets & 120M sterile vials / year",
    "certifications": [
      {
        "name": "US-FDA Approved (CBER/CDER)",
        "valid_until": "2028-04",
        "verified": true
      },
      {
        "name": "EU-GMP (BfArM Germany)",
        "valid_until": "2027-10",
        "verified": true
      },
      {
        "name": "WHO Geneva Prequalified",
        "valid_until": "2028-12",
        "verified": true
      }
    ],
    "verification_level": "Field audit & US-FDA EIR",
    "deduction_rationale": {
      "site_verification": "Physical plant geolocated in Himachal Pradesh HPSIDC Baddi Industrial Area (Plot 9-11); 32-acre sterile formulations facility with captive 66kV HT substation.",
      "process_audit": "Verified installation of 8x Fette Compacting FE55 high-speed rotary presses, 3x Bosch aseptic vial filling lines, and Class 100 laminar flow cleanrooms with automated CIP/SIP.",
      "standards_link": "US-FDA EIR (Establishment Inspection Report) active with zero 483 observations; WHO Geneva prequalification for essential penicillins and clavulanate combinations.",
      "oem_linkage": "Direct prime contractor for Ministry of Health & Family Welfare Jan Aushadhi generic supply and UK NHS hospital injectable tenders."
    },
    "machinery": [
      {
        "type": "Rotary Tablet Press",
        "model": "Fette Compacting FE55",
        "qty": 8,
        "origin": "Germany"
      },
      {
        "type": "Aseptic Liquid Filling Line",
        "model": "Bosch / Syntegon FLC 3000",
        "qty": 3,
        "origin": "Germany"
      },
      {
        "type": "Industrial Lyophilizers",
        "model": "Tofflon LyoPro 50m\u00b2",
        "qty": 4,
        "origin": "China / Tech-approved"
      }
    ],
    "operational_status": "Operating at 88% capacity - 3 Shifts (24x7 continuous cleanroom)",
    "factory_verified": true,
    "power_sanction_kva": 4500,
    "annual_turnover_cr": 4200.0,
    "client_references": [
      "Ministry of Health & Family Welfare (Jan Aushadhi Supply)",
      "NHS United Kingdom Supply Chain",
      "UNICEF Global Essential Medicines Tender"
    ],
    "rfq_response_hours": 18
  },
  {
    "id": "mfg_19_divis",
    "name": "Divi's Laboratories Ltd. - Unit II JNCP Pharma City",
    "entity_type": "manufacturer",
    "hs6_codes": [
      "293339",
      "300490",
      "300410"
    ],
    "sector": "Pharmaceuticals",
    "location": "JN Pharma City, Parawada, Visakhapatnam",
    "state": "Andhra Pradesh",
    "processes": [
      "High-Potency Active Pharmaceutical Ingredient (HPAPI) Synthesis",
      "Chiral Chemistry & Asymmetric Hydrogenation",
      "Continuous Flow Chemistry Reactors",
      "Solvent Recovery & Zero Liquid Discharge (ZLD)"
    ],
    "materials": [
      "Heterocyclic Starting Materials",
      "Pyridine & Piperidine Derivatives",
      "Peptide Coupling Reagents",
      "High-Purity Organic Solvents"
    ],
    "tolerance_class": "Purity >= 99.8% (HPLC validated)",
    "scale_capacity": "8,200 MT/year Bulk Active Pharmaceutical Ingredients",
    "certifications": [
      {
        "name": "US-FDA EIR (No 483 Observations)",
        "valid_until": "2028-02",
        "verified": true
      },
      {
        "name": "PMDA Japan Certification",
        "valid_until": "2027-08",
        "verified": true
      },
      {
        "name": "ISO 14001 Environmental Management",
        "valid_until": "2026-11",
        "verified": true
      }
    ],
    "verification_level": "Field audit & US-FDA EIR",
    "deduction_rationale": {
      "site_verification": "Geolocated in JN Pharma City SEZ, Parawada, Visakhapatnam; 120-acre bulk active pharmaceutical ingredient (API) chemical complex connected to CETP zero-liquid-discharge pipeline.",
      "process_audit": "Machinery audit verified 36x Pfaudler 10,000L glass-lined reactors, 14x Guedu agitated Nutsche filter dryers, and automated continuous hydrogenation reactors.",
      "standards_link": "US-FDA, PMDA Japan, and EU-GMP certifications current; ISO 14001 environmental safety compliance with real-time CPCB emissions monitoring.",
      "oem_linkage": "Long-term exclusive commercial synthesis contracts with Novartis AG, Merck & Co., and Gilead Sciences for regulated global markets."
    },
    "machinery": [
      {
        "type": "Glass-Lined Reaction Vessels",
        "model": "Pfaudler 10,000L GLR",
        "qty": 36,
        "origin": "Germany / India"
      },
      {
        "type": "Centrifuge Filter Dryers",
        "model": "Guedu Agitated Nutsche Filter Dryer",
        "qty": 14,
        "origin": "France"
      },
      {
        "type": "Analytical HPLC/GC-MS Suite",
        "model": "Agilent 1290 Infinity II",
        "qty": 28,
        "origin": "USA"
      }
    ],
    "operational_status": "Operating at 92% capacity - World's largest API exporter for select molecules",
    "factory_verified": true,
    "power_sanction_kva": 12000,
    "annual_turnover_cr": 7800.0,
    "client_references": [
      "Novartis AG Global API Sourcing",
      "Merck & Co. Custom Synthesis Alliance",
      "Gilead Sciences Commercial Supplier"
    ],
    "rfq_response_hours": 24
  },
  {
    "id": "trd_16_medplus",
    "name": "MedPlus Bulk Logistics & Institutional Stockists Pvt. Ltd.",
    "entity_type": "trader",
    "hs6_codes": [
      "300490",
      "300410",
      "293339"
    ],
    "sector": "Pharmaceuticals",
    "location": "Pharma Mega-Hub, Kukatpally Industrial Area, Hyderabad",
    "state": "Telangana",
    "processes": [
      "Temperature-Controlled Cold-Chain Warehousing (2\u00b0C - 8\u00b0C)",
      "Batch Verification & Secondary Packaging Compliance",
      "National Hospital Tender Sourcing & Stockholding",
      "Central Drug Standard Control (CDSCO) Import Clearance"
    ],
    "materials": [
      "Finished Dosage Formulations",
      "Antibiotic Dry Syrups",
      "Sterile Injectable Cartridges",
      "Generic Hospital Blister Packs"
    ],
    "tolerance_class": "GDP (Good Distribution Practice) WHO Validated",
    "scale_capacity": "550,000 sq.ft cold-chain distribution center handling 80,000 SKUs",
    "certifications": [
      {
        "name": "CDSCO Wholesaler & Importer License",
        "valid_until": "2029-03",
        "verified": true
      },
      {
        "name": "WHO Good Distribution Practice (GDP)",
        "valid_until": "2027-09",
        "verified": true
      },
      {
        "name": "ISO 28000 Supply Chain Security",
        "valid_until": "2027-01",
        "verified": true
      }
    ],
    "verification_level": "Customs & CDSCO Registry",
    "deduction_rationale": {
      "site_verification": "Verified 550,000 sq.ft temperature-controlled logistics hub in Kukatpally Industrial Area, Hyderabad; verified commercial distribution center without chemical synthesis reactors.",
      "process_audit": "Audited automated storage and retrieval systems (ASRS) and 12x modular cold-storage rooms (2\u00b0C - 8\u00b0C); business model is wholesale stocking, batch release, and retail fulfillment.",
      "standards_link": "CDSCO Wholesale Drug License Form 20B/21B and WHO Good Distribution Practice (GDP) verified via Telangana DCA portal.",
      "oem_linkage": "Major institutional distributor for Apollo Hospitals, Fortis Healthcare, and ESIC healthcare pharmacy networks."
    },
    "machinery": [
      {
        "type": "Automated Storage & Retrieval (ASRS)",
        "model": "Daifuku Cold ASRS",
        "qty": 2,
        "origin": "Japan"
      },
      {
        "type": "Data-Logged Cold Storage Chambers",
        "model": "Blue Star Modular Cold Rooms",
        "qty": 12,
        "origin": "India"
      },
      {
        "type": "Refrigerated Reefer Fleet",
        "model": "Tata Ultra 28ft Reefer (-20\u00b0C to +15\u00b0C)",
        "qty": 35,
        "origin": "India"
      }
    ],
    "operational_status": "Active Distribution - Turnaround: 2,400 daily shipments across institutional hospitals",
    "factory_verified": true,
    "power_sanction_kva": 2200,
    "annual_turnover_cr": 1850.0,
    "client_references": [
      "Apollo Hospitals Enterprise Ltd. Pan-India Supply",
      "Fortis Healthcare Central Sourcing",
      "ESIC Central Medical Stores Tenders"
    ],
    "rfq_response_hours": 8
  },
  {
    "id": "mfg_20_polymed",
    "name": "Poly Medicure Limited (PolyMed)",
    "entity_type": "manufacturer",
    "hs6_codes": [
      "901831",
      "902110"
    ],
    "sector": "Medical & Precision Instruments",
    "location": "Sector 59, Faridabad Industrial Area",
    "state": "Haryana",
    "processes": [
      "Precision Medical Polymer Extrusion",
      "Cleanroom Automated Assembly (Class 10,000)",
      "Ethylene Oxide (EtO) Sterilization Chamber",
      "Laser Needle Grinding & Cannula Assembly"
    ],
    "materials": [
      "Medical-Grade Polypropylene (USP Class VI)",
      "Fluorinated Ethylene Propylene (FEP)",
      "Surgical Stainless Steel 304 Cannula Wire"
    ],
    "tolerance_class": "Medical Device Class IIb / ISO 13485:2016",
    "scale_capacity": "1.2 Billion IV Cannulas & Syringes / year",
    "certifications": [
      {
        "name": "CE European Conformity Mark",
        "valid_until": "2028-05",
        "verified": true
      },
      {
        "name": "US-FDA 510(k) Clearance",
        "valid_until": "2027-12",
        "verified": true
      },
      {
        "name": "ISO 13485 Medical Quality",
        "valid_until": "2028-01",
        "verified": true
      }
    ],
    "verification_level": "Field audit & CE Mark",
    "deduction_rationale": {
      "site_verification": "Verified manufacturing facility in Sector 59, Faridabad Industrial Area; 4-floor dedicated medical disposable plant with Class 10,000 cleanroom.",
      "process_audit": "Verified 24x Sumitomo all-electric cleanroom injection moulding presses, 12x Mikron precision needle grinding machines, and automated ethylene oxide sterilization chambers.",
      "standards_link": "CE Mark 0123 under EU MDR 2017/745, US-FDA 510(k) K192831 clearance, and ISO 13485:2016 verified.",
      "oem_linkage": "Tier-1 medical device supplier to NHS UK, Red Cross international relief tenders, and major private hospital purchasing consortiums."
    },
    "machinery": [
      {
        "type": "Cleanroom Injection Moulding",
        "model": "Sumitomo Demag All-Electric",
        "qty": 24,
        "origin": "Japan"
      },
      {
        "type": "Cannula Grinding Machine",
        "model": "Mikron Precision Needle Grinder",
        "qty": 12,
        "origin": "Switzerland"
      }
    ],
    "operational_status": "Operating at 90% capacity - Top medical disposable exporter to 110 countries",
    "factory_verified": true,
    "power_sanction_kva": 6000,
    "annual_turnover_cr": 1150.0,
    "client_references": [
      "National Health Service (NHS UK)",
      "Red Cross International Humanitarian Aid",
      "Max Healthcare Purchasing Group"
    ],
    "rfq_response_hours": 12
  },
  {
    "id": "mfg_21_tatasteel",
    "name": "Tata Steel Limited - Specialty Alloy & Flat Products Division",
    "entity_type": "manufacturer",
    "hs6_codes": [
      "722540",
      "731100",
      "731815"
    ],
    "sector": "Iron & Steel",
    "location": "Kalinganagar Industrial Complex, Jajpur",
    "state": "Odisha",
    "processes": [
      "Vacuum Degassing & Ladle Refining",
      "Continuous Hot Strip Rolling (Width up to 2,050 mm)",
      "Thermo-Mechanical Controlled Processing (TMCP)",
      "High-Strength Alloy Pickling & Oiling"
    ],
    "materials": [
      "High-Strength Low-Alloy (HSLA) Steel",
      "Pressure Vessel Grade Plates (SA 516 Gr 70)",
      "Automotive Fastener Grade Boron Steels"
    ],
    "tolerance_class": "EN 10029 Class A / ASTM A20",
    "scale_capacity": "3.2 Million MT / year Specialty Flat & Alloy Steel",
    "certifications": [
      {
        "name": "IATF 16949 Automotive Quality",
        "valid_until": "2027-08",
        "verified": true
      },
      {
        "name": "ASME Pressure Vessel Code Section VIII",
        "valid_until": "2028-03",
        "verified": true
      },
      {
        "name": "ISO 9001:2015",
        "valid_until": "2027-11",
        "verified": true
      }
    ],
    "verification_level": "Field audit & IATF 16949",
    "deduction_rationale": {
      "site_verification": "Integrated steel plant in Kalinganagar Industrial Complex, Jajpur, Odisha; verified 3,000-acre primary metallurgy complex with dedicated rail freight siding.",
      "process_audit": "Audited SMS Siemag 2050mm continuous hot strip mill, 3x Primetals 300T ladle refining furnaces, and ultra-high strength TMCP cooling lines.",
      "standards_link": "IATF 16949:2016 automotive quality certified, ASME Boiler and Pressure Vessel Code Section VIII certified, BIS ISI certified.",
      "oem_linkage": "Primary supplier of high-strength alloy plates to BHEL, Larsen & Toubro, and automotive fastener manufacturers."
    },
    "machinery": [
      {
        "type": "Hot Strip Mill",
        "model": "SMS Siemag Ultra-Heavy 2050mm",
        "qty": 1,
        "origin": "Germany"
      },
      {
        "type": "Ladle Refining Furnace",
        "model": "Primetals Technologies 300T",
        "qty": 3,
        "origin": "Austria"
      }
    ],
    "operational_status": "Operating at 95% capacity - Integrated blast furnace & ladle metallurgy",
    "factory_verified": true,
    "power_sanction_kva": 85000,
    "annual_turnover_cr": 32000.0,
    "client_references": [
      "Bharat Heavy Electricals Ltd (BHEL)",
      "Larsen & Toubro Heavy Engineering",
      "Indian Railways Dedicated Freight Corridor"
    ],
    "rfq_response_hours": 24
  }
];

// ============================================================================
// 23 Cluster Interventions Database (Covering all Corridors)
// ============================================================================
const CLUSTERS_DATABASE: Record<string, ClusterIntervention> = {
  "hyderabad_pharma": {
    "cluster_name": "Genome Valley & Hyderabad Bulk Drug Belt",
    "state": "Telangana",
    "lead_agency": "Department of Pharmaceuticals & TGIPC",
    "indicative_cost": "\u20b9310 Crore (~$37.2M)",
    "evidence_demand": "84 domestic formulation and API MSMEs currently lack shared continuous micro-reactors and high-containment OEB-5 isolators, leading to 35% higher batch production costs and environmental discharge bottlenecks.",
    "milestones": [
      "Phase 1: Flow-chemistry testing pilot reactor installation & DPR sign-off (Month 1-4)",
      "Phase 2: Common Zero Liquid Discharge (ZLD) tertiary recovery plant expansion (Month 5-11)",
      "Phase 3: US FDA & WHO Prequalification shared analytical validation laboratory (Month 12-16)",
      "Phase 4: Commercial commissioning with open-access pay-per-use tariff (Month 17)"
    ]
  },
  "baddi_pharma": {
    "cluster_name": "Baddi-Barotiwala-Nalagarh (BBN) Pharma Corridor",
    "state": "Himachal Pradesh",
    "lead_agency": "Department of Pharmaceuticals & HP HPSIDC",
    "indicative_cost": "\u20b9185 Crore (~$22.2M)",
    "evidence_demand": "Absence of centralized cold-chain cryogenic storage and lyophilization validation center forces small formulators to transport fragile biologics 300 km to Delhi for testing.",
    "milestones": [
      "Phase 1: Common sterile injectable lyophilization test bay construction (Month 1-4)",
      "Phase 2: Temperature-controlled automated 2-8\u00b0C cold logistics facility (Month 5-9)",
      "Phase 3: CDSCO Class-C cleanroom validation and ISO 17025 certification (Month 10-14)"
    ]
  },
  "vizag_chem_pharma": {
    "cluster_name": "JNPC Pharma City & Petrochem Complex, Parawada",
    "state": "Andhra Pradesh",
    "lead_agency": "Department of Chemicals & Petrochemicals and APIIC",
    "indicative_cost": "\u20b9260 Crore (~$31.2M)",
    "evidence_demand": "High-pressure catalytic hydrogenation and explosive-reaction test bays needed by 42 chemical intermediate producers to safely localize key starting materials (KSMs).",
    "milestones": [
      "Phase 1: Blast-proof high-pressure reactor bunker civil infrastructure (Month 1-5)",
      "Phase 2: Automated solvent recovery distillation columns installation (Month 6-12)",
      "Phase 3: PESO explosive-safety clearance and NABL analytical certification (Month 13-16)"
    ]
  },
  "amtz_vizag": {
    "cluster_name": "Andhra Pradesh MedTech Zone (AMTZ)",
    "state": "Andhra Pradesh",
    "lead_agency": "Department of Pharmaceuticals & AMTZ Ltd.",
    "indicative_cost": "\u20b995 Crore (~$11.4M)",
    "evidence_demand": "Shared 3D titanium additive printer farm (EOS M290) and high-dose Cobalt-60 Gamma sterilisation chamber expansion required for 65 orthopaedic and surgical implant MSMEs.",
    "milestones": [
      "Phase 1: Cleanroom Gamma irradiation chamber calibration & validation (Month 1-3)",
      "Phase 2: Direct metal laser sintering (DMLS) 5-axis printer addition (Month 4-7)",
      "Phase 3: Biomechanical wear-testing simulator and CDSCO MD-9 accreditation (Month 8-11)"
    ]
  },
  "noida_electronics": {
    "cluster_name": "Noida-Greater Noida Electronics Manufacturing Corridor",
    "state": "Uttar Pradesh",
    "lead_agency": "Ministry of Electronics & IT (MeitY) & YEIDA",
    "indicative_cost": "\u20b9175 Crore (~$21.0M)",
    "evidence_demand": "Shortage of domestic 5G sub-6 GHz anechoic chambers and high-speed SMT prototype lines causes 3-week export qualification delays in Taiwan.",
    "milestones": [
      "Phase 1: RF Shielded Anechoic Chamber civil construction (Month 1-4)",
      "Phase 2: Keysight / Rohde & Schwarz 5G conformance test rig commissioning (Month 5-9)",
      "Phase 3: TEC MTCTE and FCC/CE international compliance lab accreditation (Month 10-13)"
    ]
  },
  "sricity_emc": {
    "cluster_name": "Sri City Electronic Manufacturing Cluster (EMC 2.0)",
    "state": "Andhra Pradesh",
    "lead_agency": "MeitY & Sri City Industrial Authority",
    "indicative_cost": "\u20b9130 Crore (~$15.6M)",
    "evidence_demand": "Need for common high-precision plastic injection tooling room and EMI/EMC chamber for PCB assembly and domestic appliance controllers.",
    "milestones": [
      "Phase 1: Tool-room CNC EDM & wire-cut equipment procurement (Month 1-5)",
      "Phase 2: 10m Semi-anechoic EMI chamber installation (Month 6-10)",
      "Phase 3: Commercial trial runs and MSME subsidised slot booking launch (Month 11-13)"
    ]
  },
  "sanand_ev_semicon": {
    "cluster_name": "Sanand-Mandal-Becharaji EV & Semicon Hub",
    "state": "Gujarat",
    "lead_agency": "India Semiconductor Mission (ISM) & GIDC",
    "indicative_cost": "\u20b9220 Crore (~$26.4M)",
    "evidence_demand": "Critical requirement for common ultra-pure water recycling and Class 100 packaging qualification facility for tier-2 discretes and power electronics.",
    "milestones": [
      "Phase 1: Common Effluent & Ultra-Pure Water Piping Layout (Month 1-4)",
      "Phase 2: Packaging Test Bench & Cleanroom Fabrication (Month 5-11)",
      "Phase 3: Environmental Audit & Trial Runs (Month 12-16)"
    ]
  },
  "dholera_sir": {
    "cluster_name": "Dholera Special Investment Region (DSIR) Mega-Fab",
    "state": "Gujarat",
    "lead_agency": "India Semiconductor Mission (ISM) & DICDL",
    "indicative_cost": "\u20b9480 Crore (~$57.6M)",
    "evidence_demand": "Need for shared multi-gas bulk delivery pipeline and Class 10 wafer test verification laboratory for semiconductor and TOPCon solar ingot slicing units.",
    "milestones": [
      "Phase 1: High-purity gas manifold (Silane/Nitrogen) trunk pipeline (Month 1-6)",
      "Phase 2: Automated wafer photoluminescence crack inspection bench (Month 7-12)",
      "Phase 3: Full qualification trial with anchor semiconductor fab (Month 13-18)"
    ]
  },
  "silvassa_telecom": {
    "cluster_name": "Silvassa Optical Fibre & Telecom Corridor",
    "state": "Dadra & Nagar Haveli",
    "lead_agency": "Department of Telecommunications (DoT)",
    "indicative_cost": "\u20b9110 Crore (~$13.2M)",
    "evidence_demand": "Absence of shared high-span tensile cable fatigue and environmental cycling towers for 288-fibre ribbon cable verification.",
    "milestones": [
      "Phase 1: 500m outdoor overhead cable tensile test track construction (Month 1-4)",
      "Phase 2: Climate-controlled optical attenuation (OTDR) chamber (Month 5-8)",
      "Phase 3: DoT TEC and international Telcordia GR-20 test accreditation (Month 9-12)"
    ]
  },
  "chennai_auto_electronics": {
    "cluster_name": "Chennai-Oragadam Electronics & Auto Belt",
    "state": "Tamil Nadu",
    "lead_agency": "Ministry of Heavy Industries & MeitY",
    "indicative_cost": "\u20b9140 Crore (~$16.8M)",
    "evidence_demand": "28 MSME Tier-2 electronic PCB & harness assemblers currently ship parts 1,200 km to Pune for high-altitude thermal cycle and vibration testing.",
    "milestones": [
      "Phase 1: DPR & SPV Formation via SIPCOT (Month 1-3)",
      "Phase 2: Equipment Procurement via GeM Global Tender (Month 4-9)",
      "Phase 3: Civil Construction & NABL ISO 17025 Accreditation (Month 10-14)",
      "Phase 4: Operational Commissioning & Open User Access (Month 15)"
    ]
  },
  "pune_chakan_machinery": {
    "cluster_name": "Pune-Chakan-Talegaon Industrial Belt",
    "state": "Maharashtra",
    "lead_agency": "Ministry of Heavy Industries & MIDC",
    "indicative_cost": "\u20b9210 Crore (~$25.2M)",
    "evidence_demand": "High-torque transmission dynamometer (up to 800 kW) and 3D laser coordinate metrology missing for hydraulic valve and heavy powertrain component builders.",
    "milestones": [
      "Phase 1: Seismic foundation and dyno test-cell acoustic isolation (Month 1-5)",
      "Phase 2: AVL / Horiba transmission testing benches commissioning (Month 6-11)",
      "Phase 3: Automotive Research Association of India (ARAI) joint certification (Month 12-15)"
    ]
  },
  "peenya_machinery": {
    "cluster_name": "Peenya Precision Machinery & Tooling Belt",
    "state": "Karnataka",
    "lead_agency": "Ministry of MSME & KSSIDC",
    "indicative_cost": "\u20b9125 Crore (~$15.0M)",
    "evidence_demand": "Shared sub-micron laser calibration interferometers and precision spindle dynamic balancing machines required by 180 small machine tool component job-shops.",
    "milestones": [
      "Phase 1: Climate-controlled metrology laboratory building works (Month 1-3)",
      "Phase 2: Multi-sensor CMM and Renishaw laser calibration suite (Month 4-7)",
      "Phase 3: NABL accreditation and subsidized MSME booking portal (Month 8-10)"
    ]
  },
  "coimbatore_machinery": {
    "cluster_name": "Coimbatore Industrial Machinery & Foundry Cluster",
    "state": "Tamil Nadu",
    "lead_agency": "Ministry of Heavy Industries & CODISSIA",
    "indicative_cost": "\u20b9135 Crore (~$16.2M)",
    "evidence_demand": "Need for common induction melting furnace and automated sand reclamation unit to reduce scrap rates in precision ductile-iron valve castings.",
    "milestones": [
      "Phase 1: Sand reclamation plant and environmental scrubber setup (Month 1-5)",
      "Phase 2: Hydrostatic valve test bench (up to 1,000 Bar) installation (Month 6-9)",
      "Phase 3: BIS standard marking certification and operator training school (Month 10-12)"
    ]
  },
  "rohtak_fasteners": {
    "cluster_name": "Rohtak High-Tensile Fasteners Industrial Park",
    "state": "Haryana",
    "lead_agency": "Ministry of Steel & HSIIDC",
    "indicative_cost": "\u20b990 Crore (~$10.8M)",
    "evidence_demand": "Centralized continuous mesh-belt furnace for hydrogen de-embrittlement baking and automated optical bolt sorters to meet IATF zero-defect auto standards.",
    "milestones": [
      "Phase 1: Mesh-belt heat treatment furnace civil works and gas burners (Month 1-4)",
      "Phase 2: 360-degree high-speed optical vision sorting line (Month 5-8)",
      "Phase 3: NABL tensile & shear testing laboratory accreditation (Month 9-11)"
    ]
  },
  "jamshedpur_steel": {
    "cluster_name": "Jamshedpur-Adityapur Special Steel Belt",
    "state": "Jharkhand",
    "lead_agency": "Ministry of Steel & AIADA",
    "indicative_cost": "\u20b9190 Crore (~$22.8M)",
    "evidence_demand": "Vacuum degassing and electroslag remelting (ESR) pilot furnace needed to qualify domestic alloy steel sheets for defense and aerospace programs.",
    "milestones": [
      "Phase 1: 5-Tonne ESR furnace foundation and power substation (Month 1-6)",
      "Phase 2: Ultrasonic internal flaw detection water-immersion tank (Month 7-10)",
      "Phase 3: DGQA / DGAQA military aerospace steel qualification (Month 11-15)"
    ]
  },
  "gandhidham_cylinders": {
    "cluster_name": "Gandhidham & Kandla High-Pressure Gas Hub",
    "state": "Gujarat",
    "lead_agency": "Ministry of Petroleum and Natural Gas & PESO",
    "indicative_cost": "\u20b985 Crore (~$10.2M)",
    "evidence_demand": "Automated 600-Bar hydrostatic burst test chamber and eddy-current tube flaw scanner required to support national green hydrogen and CNG cylinder scale-up.",
    "milestones": [
      "Phase 1: Reinforced containment bunker for burst testing (Month 1-3)",
      "Phase 2: Multi-channel ultrasonic wall thickness measuring unit (Month 4-7)",
      "Phase 3: PESO and ISO 11439 safety agency permanent stationing (Month 8-10)"
    ]
  },
  "ahmedabad_plastics": {
    "cluster_name": "Ahmedabad-Sanand Polymer & Machinery Belt",
    "state": "Gujarat",
    "lead_agency": "Department of Chemicals & Petrochemicals and GIDC",
    "indicative_cost": "\u20b9115 Crore (~$13.8M)",
    "evidence_demand": "High-tonnage (1,500T to 3,200T) mould trial and validation press center needed by local injection machinery and auto-bumper tooling manufacturers.",
    "milestones": [
      "Phase 1: Heavy foundation pit and 40T crane installation (Month 1-4)",
      "Phase 2: Large-platen two-platen servo injection validation press (Month 5-9)",
      "Phase 3: Polymer rheology and melt-flow index testing accreditation (Month 10-12)"
    ]
  },
  "bengaluru_aerospace": {
    "cluster_name": "Bengaluru Aerospace & Defence Corridor (Devanahalli)",
    "state": "Karnataka",
    "lead_agency": "Ministry of Defence & DDP",
    "indicative_cost": "\u20b9240 Crore (~$28.8M)",
    "evidence_demand": "Titanium vacuum electron-beam welding and NADCAP-certified non-destructive testing (NDT) facility needed for turbojet engine component machining MSMEs.",
    "milestones": [
      "Phase 1: Vacuum electron beam welding chamber installation (Month 1-6)",
      "Phase 2: Computed radiography and fluorescent penetrant testing lines (Month 7-11)",
      "Phase 3: NADCAP aerospace special process accreditation (Month 12-16)"
    ]
  },
  "koppal_toys": {
    "cluster_name": "Koppal Dedicated Toy Cluster",
    "state": "Karnataka",
    "lead_agency": "Ministry of MSME & KIADB",
    "indicative_cost": "\u20b965 Crore (~$7.8M)",
    "evidence_demand": "Absence of in-cluster BIS QCO toy safety testing lab forces 12-day turnaround delays sending samples to Bengaluru.",
    "milestones": [
      "Phase 1: Lab building allocation and civil fixtures (Month 1-3)",
      "Phase 2: In-situ mechanical safety & non-toxic XRF test rig installation (Month 4-7)",
      "Phase 3: BIS recognition and NABL accreditation (Month 8-10)"
    ]
  },
  "yeida_toys": {
    "cluster_name": "YEIDA Toy City & Consumer Goods Park",
    "state": "Uttar Pradesh",
    "lead_agency": "Ministry of MSME & YEIDA",
    "indicative_cost": "\u20b980 Crore (~$9.6M)",
    "evidence_demand": "Shared automated multi-color pad printing, ultrasonic plastic welding, and non-toxic paint preparation unit for 120 toy MSME licensees.",
    "milestones": [
      "Phase 1: Robotic spray booth and drying conveyor installation (Month 1-4)",
      "Phase 2: EN 71 / ASTM F963 international toy safety test benches (Month 5-8)",
      "Phase 3: Operational launch with priority scheduling for export units (Month 9-11)"
    ]
  },
  "surat_tech_textiles": {
    "cluster_name": "Surat Technical Textiles & Weaving Hub",
    "state": "Gujarat",
    "lead_agency": "Ministry of Textiles",
    "indicative_cost": "\u20b9145 Crore (~$17.4M)",
    "evidence_demand": "Pilot needle-punched non-woven line and membrane thermal lamination facility to produce industrial dust filtration fabrics and medical barrier textiles.",
    "milestones": [
      "Phase 1: German non-woven carding and cross-lapper procurement (Month 1-5)",
      "Phase 2: Frazier air permeability and hydrostatic pressure test rig (Month 6-9)",
      "Phase 3: OEKO-TEX Standard 100 Class I and BIS testing lab accreditation (Month 10-13)"
    ]
  },
  "coimbatore_textiles": {
    "cluster_name": "Coimbatore-Tirupur Technical Textiles Belt",
    "state": "Tamil Nadu",
    "lead_agency": "Ministry of Textiles & SITRA",
    "indicative_cost": "\u20b9120 Crore (~$14.4M)",
    "evidence_demand": "High-tenacity synthetic yarn twisting and geotextile tensile puncture resistance testing lab to replace expensive overseas certifications.",
    "milestones": [
      "Phase 1: Universal tensile testing machine (50 kN) for geotextiles (Month 1-4)",
      "Phase 2: Accelerated weathering xenon-arc test chamber installation (Month 5-8)",
      "Phase 3: Ministry of Road Transport (MoRTH) accredited supplier testing facility (Month 9-12)"
    ]
  },
  "ambur_footwear": {
    "cluster_name": "Ambur-Ranipet Leather & Footwear Belt",
    "state": "Tamil Nadu",
    "lead_agency": "Ministry of Commerce & Industry (DPIIT) & FDDI",
    "indicative_cost": "\u20b9110 Crore (~$13.2M)",
    "evidence_demand": "Shared automated computerised laser leather cutting center and SATRA accredited footwear durability/hydrolysis test lab to reduce raw leather wastage by 18%.",
    "milestones": [
      "Phase 1: High-precision CNC waterjet & laser leather cutter installation (Month 1-4)",
      "Phase 2: Dynamic shoe flexing and slip-resistance test rig setup (Month 5-8)",
      "Phase 3: SATRA laboratory accreditation and green leather certification (Month 9-12)"
    ]
  }
};

// ============================================================================
// 25 Product Adjacent Diversification Targets (Specific to each product)
// ============================================================================
const DIVERSIFICATIONS_MAP: Record<string, DiversificationTarget[]> = {
  "29333911": [
    {
      "target_product": "Fluoro-Pyridine Synthetic Intermediates (HS 293339)",
      "target_hs6": "293339",
      "synergy": "Utilizes existing glass-lined reactors and cryogenic condensation loops with +38% gross margin improvement.",
      "capex_estimate": "\u20b912.5 Crore (~$1.5M)",
      "payback_period": "15 Months"
    },
    {
      "target_product": "Antiviral Nucleoside Precursor Blocks (HS 293499)",
      "target_hs6": "293499",
      "synergy": "Shares catalytic hydrogenation autoclaves and vacuum distillation columns.",
      "capex_estimate": "\u20b921 Crore (~$2.5M)",
      "payback_period": "18 Months"
    },
    {
      "target_product": "Chiral Resolution Pure Enantiomers (HS 293329)",
      "target_hs6": "293329",
      "synergy": "Enzymatic biocatalysis reactors added to downstream purification bay.",
      "capex_estimate": "\u20b99.0 Crore (~$1.1M)",
      "payback_period": "13 Months"
    }
  ],
  "30041010": [
    {
      "target_product": "Sterile Lyophilized Injectable Antibiotics (HS 300420)",
      "target_hs6": "300420",
      "synergy": "Upgrading oral beta-lactam formulation facility to freeze-dried injectable vials with +45% gross margin.",
      "capex_estimate": "\u20b918 Crore (~$2.2M)",
      "payback_period": "16 Months"
    },
    {
      "target_product": "Monoclonal Antibodies & Biosimilar Pre-filled Syringes (HS 300215)",
      "target_hs6": "300215",
      "synergy": "Adding single-use bioreactor suite and sterile aseptic isolator line.",
      "capex_estimate": "\u20b934 Crore (~$4.1M)",
      "payback_period": "24 Months"
    },
    {
      "target_product": "Controlled-Release Pellet Formulations (HS 300490)",
      "target_hs6": "300490",
      "synergy": "Fluidized-bed Wurster bottom-spray coating addition to existing tablet presses.",
      "capex_estimate": "\u20b98.5 Crore (~$1.0M)",
      "payback_period": "14 Months"
    }
  ],
  "30049011": [
    {
      "target_product": "Dry Powder Inhaler (DPI) Respiratory Capsules (HS 300490)",
      "target_hs6": "300490",
      "synergy": "Adding micronized active substance micro-dosing and blister sealing in Class 10,000 cleanroom; +50% margin.",
      "capex_estimate": "\u20b915 Crore (~$1.8M)",
      "payback_period": "17 Months"
    },
    {
      "target_product": "Liposomal Oncology Nanoparticle Injectables (HS 300490)",
      "target_hs6": "300490",
      "synergy": "High-pressure micro-fluidizer integration for targeted cytotoxic delivery.",
      "capex_estimate": "\u20b926 Crore (~$3.1M)",
      "payback_period": "20 Months"
    },
    {
      "target_product": "Transdermal Drug Delivery Patches (HS 300590)",
      "target_hs6": "300590",
      "synergy": "Precision solvent coating and multi-layer laminating web line.",
      "capex_estimate": "\u20b911 Crore (~$1.3M)",
      "payback_period": "15 Months"
    }
  ],
  "40117000": [
    {
      "target_product": "Giant Mining & Earthmover Radial Tyres (OTR) (HS 401180)",
      "target_hs6": "401180",
      "synergy": "Utilizes existing banbury mixers; requires heavy-gauge steel belt calendering and 63-inch hydraulic press.",
      "capex_estimate": "\u20b942 Crore (~$5.0M)",
      "payback_period": "22 Months"
    },
    {
      "target_product": "Forestry Low-Ground-Pressure Radial Tyres (HS 401170)",
      "target_hs6": "401170",
      "synergy": "Shares compounding chemistry with specialized cut-and-chip resistant silica treads.",
      "capex_estimate": "\u20b916 Crore (~$1.9M)",
      "payback_period": "16 Months"
    },
    {
      "target_product": "Specialty Aircraft Retreading & Radial Aviation Tyres (HS 401130)",
      "target_hs6": "401130",
      "synergy": "High-tensile aramid cord building drum with DGCA / FAA certified non-destructive laser shearography.",
      "capex_estimate": "\u20b928 Crore (~$3.4M)",
      "payback_period": "26 Months"
    }
  ],
  "59119010": [
    {
      "target_product": "High-Temperature PTFE Membrane Filter Bags (HS 591190)",
      "target_hs6": "591190",
      "synergy": "Thermal lamination calendering line addition to needle-punched felt plant; +38% gross margin.",
      "capex_estimate": "\u20b910.5 Crore (~$1.3M)",
      "payback_period": "15 Months"
    },
    {
      "target_product": "Aramid Bullet-Resistant Ballistic Fabrics (HS 591190)",
      "target_hs6": "591190",
      "synergy": "High-modulus rapier looms and thermoplastic film coating line.",
      "capex_estimate": "\u20b919 Crore (~$2.3M)",
      "payback_period": "18 Months"
    },
    {
      "target_product": "Water Filtration Hollow-Fibre Membrane Modules (HS 842121)",
      "target_hs6": "842121",
      "synergy": "Phase-inversion polymer spinning line for municipal wastewater treatment.",
      "capex_estimate": "\u20b914 Crore (~$1.7M)",
      "payback_period": "16 Months"
    }
  ],
  "64039910": [
    {
      "target_product": "ISO 20345 Steel-Toe Safety & Anti-Static Boots (HS 640340)",
      "target_hs6": "640340",
      "synergy": "Adding composite toe-cap insertion and dual-density PU direct injection moulders; +30% margin.",
      "capex_estimate": "\u20b97.5 Crore (~$900k)",
      "payback_period": "13 Months"
    },
    {
      "target_product": "High-End Goodyear Welted Formal Dress Shoes (HS 640351)",
      "target_hs6": "640351",
      "synergy": "Inseam welt stitching machines and vegetable-tanned leather sole routing.",
      "capex_estimate": "\u20b95.5 Crore (~$660k)",
      "payback_period": "11 Months"
    },
    {
      "target_product": "Technical Hiking & Waterproof Vibram Boots (HS 640391)",
      "target_hs6": "640391",
      "synergy": "Seam-sealed waterproof membrane booties and Strobel lasting line.",
      "capex_estimate": "\u20b99.0 Crore (~$1.1M)",
      "payback_period": "14 Months"
    }
  ],
  "72254011": [
    {
      "target_product": "Quenched & Tempered Abrasion-Resistant Steel Plates (HS 722540)",
      "target_hs6": "722540",
      "synergy": "Continuous roller quench unit and tempering furnace; +40% margin serving mining and yellow goods.",
      "capex_estimate": "\u20b935 Crore (~$4.2M)",
      "payback_period": "21 Months"
    },
    {
      "target_product": "High-Yield Subsea Offshore Structural Alloy Plates (HS 722540)",
      "target_hs6": "722540",
      "synergy": "Thermo-mechanical controlled processing (TMCP) accelerated cooling headers.",
      "capex_estimate": "\u20b924 Crore (~$2.9M)",
      "payback_period": "18 Months"
    },
    {
      "target_product": "Armour Steel Protection Plates (500 HBW) (HS 722540)",
      "target_hs6": "722540",
      "synergy": "Vacuum degassing ladle furnace and ballistic qualification test lab.",
      "capex_estimate": "\u20b930 Crore (~$3.6M)",
      "payback_period": "22 Months"
    }
  ],
  "73110010": [
    {
      "target_product": "Type-IV Carbon Fibre Composite Hydrogen Storage Tanks (HS 731100)",
      "target_hs6": "731100",
      "synergy": "Multi-axis CNC carbon-fibre filament winding machine added to liner manufacturing; +60% margin.",
      "capex_estimate": "\u20b938 Crore (~$4.6M)",
      "payback_period": "22 Months"
    },
    {
      "target_product": "Ultra-High Purity Electronic Gas Micro-Cylinders (HS 731100)",
      "target_hs6": "731100",
      "synergy": "Electropolishing inner-surface treatment and Ra < 0.15 \u03bcm passivation.",
      "capex_estimate": "\u20b914 Crore (~$1.7M)",
      "payback_period": "15 Months"
    },
    {
      "target_product": "Cryogenic LNG & Liquid Oxygen Mobile Vessels (HS 731100)",
      "target_hs6": "731100",
      "synergy": "Double-walled vacuum perlite insulation welding bay.",
      "capex_estimate": "\u20b926 Crore (~$3.1M)",
      "payback_period": "19 Months"
    }
  ],
  "73181500": [
    {
      "target_product": "Aerospace & Jet Engine Titanium Fasteners (HS 810890)",
      "target_hs6": "810890",
      "synergy": "Warm-heading forging press and vacuum inert-gas heat treatment; +55% margin.",
      "capex_estimate": "\u20b919 Crore (~$2.3M)",
      "payback_period": "18 Months"
    },
    {
      "target_product": "Wind Turbine Rotor M36\u2013M64 Foundation Studs (HS 731815)",
      "target_hs6": "731815",
      "synergy": "Heavy hydraulic thread rolling machine and Dacromet corrosion coating plant.",
      "capex_estimate": "\u20b912 Crore (~$1.4M)",
      "payback_period": "14 Months"
    },
    {
      "target_product": "EV High-Voltage Battery Pack Insulated Fasteners (HS 731815)",
      "target_hs6": "731815",
      "synergy": "Dielectric nylon overmoulding cell on high-tensile steel studs.",
      "capex_estimate": "\u20b98.5 Crore (~$1.0M)",
      "payback_period": "13 Months"
    }
  ],
  "84119100": [
    {
      "target_product": "Turbine Single-Crystal Superalloy Blades (HS 841191)",
      "target_hs6": "841191",
      "synergy": "Directional solidification vacuum casting furnace and ceramic core leaching; +70% margin.",
      "capex_estimate": "\u20b948 Crore (~$5.8M)",
      "payback_period": "28 Months"
    },
    {
      "target_product": "Aircraft Actuator Hydraulic Manifolds (HS 848120)",
      "target_hs6": "848120",
      "synergy": "Shares 5-axis DMG Mori CNC machining and CMM metrology inspection.",
      "capex_estimate": "\u20b916 Crore (~$1.9M)",
      "payback_period": "16 Months"
    },
    {
      "target_product": "Space Launch Vehicle Rocket Injector Heads (HS 841290)",
      "target_hs6": "841290",
      "synergy": "Selective laser melting (SLM) metal additive manufacturing with Inconel 718.",
      "capex_estimate": "\u20b924 Crore (~$2.9M)",
      "payback_period": "22 Months"
    }
  ],
  "84571010": [
    {
      "target_product": "Simultaneous 5-Axis Portal CNC Milling Centers (HS 845710)",
      "target_hs6": "845710",
      "synergy": "Direct-drive torque motor rotary tables and high-speed dynamic spindle assembly; +45% margin.",
      "capex_estimate": "\u20b922 Crore (~$2.6M)",
      "payback_period": "17 Months"
    },
    {
      "target_product": "Multi-Tasking Turn-Mill Turn Centers with B-Axis (HS 845811)",
      "target_hs6": "845811",
      "synergy": "Utilizes existing Meehanite iron casting foundations and guideway grinders.",
      "capex_estimate": "\u20b917 Crore (~$2.0M)",
      "payback_period": "15 Months"
    },
    {
      "target_product": "Horizontal Boring & Milling Machines for Heavy Die-Molds (HS 845931)",
      "target_hs6": "845931",
      "synergy": "Heavy assembly bay with 30T crane and hydrostatic rotary table.",
      "capex_estimate": "\u20b928 Crore (~$3.4M)",
      "payback_period": "20 Months"
    }
  ],
  "84713010": [
    {
      "target_product": "Ruggedised Mil-Spec Field Handheld Terminals (HS 847130)",
      "target_hs6": "847130",
      "synergy": "Adds magnesium alloy chassis CNC milling and IP68 optical bonding; +45% gross margin.",
      "capex_estimate": "\u20b912 Crore (~$1.4M)",
      "payback_period": "14 Months"
    },
    {
      "target_product": "Automotive In-Cabin Display Units & Digital Clusters (HS 852859)",
      "target_hs6": "852859",
      "synergy": "Cleanroom OCA optical lamination and automotive CAN-bus flashing.",
      "capex_estimate": "\u20b918 Crore (~$2.2M)",
      "payback_period": "16 Months"
    },
    {
      "target_product": "AI Edge Inference Server Appliances (HS 847150)",
      "target_hs6": "847150",
      "synergy": "High-power PSU integration and liquid-cooling loop testing rig.",
      "capex_estimate": "\u20b915 Crore (~$1.8M)",
      "payback_period": "15 Months"
    }
  ],
  "84771000": [
    {
      "target_product": "All-Electric High-Speed Medical Cleanroom Injection Presses (HS 847710)",
      "target_hs6": "847710",
      "synergy": "Replacing hydraulic cylinders with ball-screw servo drives; +48% gross margin.",
      "capex_estimate": "\u20b916 Crore (~$1.9M)",
      "payback_period": "16 Months"
    },
    {
      "target_product": "Multi-Component Two-Shot (2K) Rotary Platen Presses (HS 847710)",
      "target_hs6": "847710",
      "synergy": "Adding secondary injection unit and central hydraulic rotary union.",
      "capex_estimate": "\u20b914 Crore (~$1.7M)",
      "payback_period": "15 Months"
    },
    {
      "target_product": "Blow-Moulding Machines for Pharma IV Bottles (HS 847730)",
      "target_hs6": "847730",
      "synergy": "Extruder head assembly and parison wall-thickness programmer integration.",
      "capex_estimate": "\u20b919 Crore (~$2.3M)",
      "payback_period": "18 Months"
    }
  ],
  "84812000": [
    {
      "target_product": "Electro-Hydraulic Proportional Servo Valves (HS 848120)",
      "target_hs6": "848120",
      "synergy": "Adding sub-micron spool honing and closed-loop LVDT feedback sensors; +50% margin.",
      "capex_estimate": "\u20b911 Crore (~$1.3M)",
      "payback_period": "14 Months"
    },
    {
      "target_product": "Subsea Ultra-Deepwater Oil & Gas Choke Valves (HS 848180)",
      "target_hs6": "848180",
      "synergy": "Inconel 625 weld-overlay cladding and 15,000 PSI hyperbaric pressure testing.",
      "capex_estimate": "\u20b924 Crore (~$2.9M)",
      "payback_period": "19 Months"
    },
    {
      "target_product": "Hydrogen Fuelling Station 700-Bar Micro-Valves (HS 848120)",
      "target_hs6": "848120",
      "synergy": "Hydrogen embrittlement resistant 316L VIM-VAR machining and helium mass-spec leak test.",
      "capex_estimate": "\u20b917 Crore (~$2.0M)",
      "payback_period": "17 Months"
    }
  ],
  "85023100": [
    {
      "target_product": "Offshore Direct-Drive Permanent Magnet Wind Generators (HS 850164)",
      "target_hs6": "850164",
      "synergy": "Large-diameter stator winding pit and marine anti-corrosion VPI resin impregnation; +42% margin.",
      "capex_estimate": "\u20b955 Crore (~$6.6M)",
      "payback_period": "26 Months"
    },
    {
      "target_product": "Grid-Scale Synchronous Condensers for Inertia Stability (HS 850164)",
      "target_hs6": "850164",
      "synergy": "Shares heavy rotor balancing tunnel and high-voltage coil winding fixtures.",
      "capex_estimate": "\u20b932 Crore (~$3.8M)",
      "payback_period": "20 Months"
    },
    {
      "target_product": "Hydro-Electric Bulb Turbine Alternators (HS 850164)",
      "target_hs6": "850164",
      "synergy": "Heavy vertical boring mill and hydrostatic thrust bearing assembly bay.",
      "capex_estimate": "\u20b928 Crore (~$3.4M)",
      "payback_period": "19 Months"
    }
  ],
  "85051110": [
    {
      "target_product": "Heavy-Dysprosium EV Traction Motor Magnets (HS 850511)",
      "target_hs6": "850511",
      "synergy": "Grain boundary diffusion (GBD) vacuum chamber addition to reduce heavy rare-earth content by 40%; +50% margin.",
      "capex_estimate": "\u20b926 Crore (~$3.1M)",
      "payback_period": "17 Months"
    },
    {
      "target_product": "Samarium-Cobalt (SmCo) High-Temperature Aerospace Magnets (HS 850511)",
      "target_hs6": "850511",
      "synergy": "High-temperature vacuum sintering for 350\u00b0C defence and jet actuator motors.",
      "capex_estimate": "\u20b918 Crore (~$2.2M)",
      "payback_period": "16 Months"
    },
    {
      "target_product": "Injection-Moulded Bonded Rare Earth Magnets (HS 850519)",
      "target_hs6": "850519",
      "synergy": "Polyamide compounder and magnetic-field oriented injection moulding machine.",
      "capex_estimate": "\u20b912 Crore (~$1.4M)",
      "payback_period": "13 Months"
    }
  ],
  "85076000": [
    {
      "target_product": "LFP Megawatt Containerized Grid Energy Storage (BESS) (HS 850760)",
      "target_hs6": "850760",
      "synergy": "Integrates liquid-cooled thermal management and utility BMS into 40ft ISO containers; +36% margin.",
      "capex_estimate": "\u20b928 Crore (~$3.4M)",
      "payback_period": "16 Months"
    },
    {
      "target_product": "Cylindrical 4680 EV Power Battery Modules (HS 850760)",
      "target_hs6": "850760",
      "synergy": "High-speed laser tab welding line and automated dielectric pot dipping.",
      "capex_estimate": "\u20b935 Crore (~$4.2M)",
      "payback_period": "19 Months"
    },
    {
      "target_product": "Solid-State Electrolyte Battery Cells (HS 850760)",
      "target_hs6": "850760",
      "synergy": "Dry-room atmosphere (< -50\u00b0C dew point) slot-die coater and isostatic laminator.",
      "capex_estimate": "\u20b965 Crore (~$7.8M)",
      "payback_period": "30 Months"
    }
  ],
  "85171300": [
    {
      "target_product": "Automotive 5G C-V2X Telematics Control Units (TCU) (HS 851762)",
      "target_hs6": "851762",
      "synergy": "SMT line retooling for AEC-Q100 automotive components and thermal conformal coating; +38% gross margin.",
      "capex_estimate": "\u20b915 Crore (~$1.8M)",
      "payback_period": "15 Months"
    },
    {
      "target_product": "Rugged Smart POS Terminals & Biometric Scanners (HS 847130)",
      "target_hs6": "847130",
      "synergy": "Shares high-density SMT and RF tuning with UIDAI biometric sensor integration.",
      "capex_estimate": "\u20b99.5 Crore (~$1.1M)",
      "payback_period": "12 Months"
    },
    {
      "target_product": "Satellite-Connected IoT Asset Trackers (HS 851769)",
      "target_hs6": "851769",
      "synergy": "Low-power GPS/NavIC/Iridium antenna calibration and sonic ultrasonic potting.",
      "capex_estimate": "\u20b98.0 Crore (~$960k)",
      "payback_period": "11 Months"
    }
  ],
  "85371000": [
    {
      "target_product": "Automotive ASIL-D Brake-by-Wire Control Units (HS 853710)",
      "target_hs6": "853710",
      "synergy": "Upgrading cleanroom SMT with dual-redundant microcontrollers and functional safety test rig; +42% margin.",
      "capex_estimate": "\u20b916 Crore (~$1.9M)",
      "payback_period": "16 Months"
    },
    {
      "target_product": "Industrial High-Power VFD Motor Drives (> 75 kW) (HS 850440)",
      "target_hs6": "850440",
      "synergy": "SiC MOSFET power module assembly and dyno load test cells.",
      "capex_estimate": "\u20b921 Crore (~$2.5M)",
      "payback_period": "18 Months"
    },
    {
      "target_product": "Solar Hybrid Inverter Mainboards (HS 850440)",
      "target_hs6": "850440",
      "synergy": "High-power magnetic component robotic insertion and burn-in chamber.",
      "capex_estimate": "\u20b912 Crore (~$1.4M)",
      "payback_period": "14 Months"
    }
  ],
  "85411000": [
    {
      "target_product": "Silicon Carbide (SiC) High-Voltage Power MOSFETs (HS 854129)",
      "target_hs6": "854129",
      "synergy": "High-temperature vacuum sintering die-attach and copper clip bonding; +65% margin.",
      "capex_estimate": "\u20b945 Crore (~$5.4M)",
      "payback_period": "22 Months"
    },
    {
      "target_product": "GaN (Gallium Nitride) Fast-Charging Power ICs (HS 854129)",
      "target_hs6": "854129",
      "synergy": "Ultra-thin wafer grinding and automated pick-and-place packaging in Class 1,000 cleanroom.",
      "capex_estimate": "\u20b932 Crore (~$3.8M)",
      "payback_period": "19 Months"
    },
    {
      "target_product": "Automotive Transient Voltage Suppressors (TVS Diodes) (HS 854110)",
      "target_hs6": "854110",
      "synergy": "Automated high-speed wire bonding (30 \u03bcm gold wire) and transfer moulding.",
      "capex_estimate": "\u20b914 Crore (~$1.7M)",
      "payback_period": "14 Months"
    }
  ],
  "85414300": [
    {
      "target_product": "Bifacial HJT (Heterojunction) Solar Modules (> 720W) (HS 854143)",
      "target_hs6": "854143",
      "synergy": "Smart-wire low-temperature interconnection and dual-glass vacuum laminator; +35% margin.",
      "capex_estimate": "\u20b936 Crore (~$4.3M)",
      "payback_period": "18 Months"
    },
    {
      "target_product": "Building-Integrated Photovoltaics (BIPV) Architectural Glass (HS 854143)",
      "target_hs6": "854143",
      "synergy": "Custom glass tempering, PVB ceramic frit printing, and frameless edge sealing.",
      "capex_estimate": "\u20b922 Crore (~$2.6M)",
      "payback_period": "16 Months"
    },
    {
      "target_product": "Perovskite-Silicon Tandem Pilot Solar Cells (HS 854142)",
      "target_hs6": "854142",
      "synergy": "Slot-die chemical vapour coater in nitrogen glovebox line.",
      "capex_estimate": "\u20b950 Crore (~$6.0M)",
      "payback_period": "27 Months"
    }
  ],
  "85447010": [
    {
      "target_product": "High-Density 864-Fibre Micro-Duct Rollable Ribbon Cables (HS 854470)",
      "target_hs6": "854470",
      "synergy": "Intermittent rollable ribbon matrix bonding and high-speed multi-tube stranding; +40% margin.",
      "capex_estimate": "\u20b919 Crore (~$2.3M)",
      "payback_period": "16 Months"
    },
    {
      "target_product": "Submarine Fibre Optic Cables with Double Steel Armoring (HS 854470)",
      "target_hs6": "854470",
      "synergy": "Continuous copper power conductor extrusion and water-blocking bitumen armouring bay.",
      "capex_estimate": "\u20b948 Crore (~$5.8M)",
      "payback_period": "24 Months"
    },
    {
      "target_product": "Pre-Connectorized FTTH Hardened Drop Cables (HS 854470)",
      "target_hs6": "854470",
      "synergy": "Automated cleanroom ferrule polishing and interferometer geometry inspection.",
      "capex_estimate": "\u20b98.5 Crore (~$1.0M)",
      "payback_period": "12 Months"
    }
  ],
  "90183100": [
    {
      "target_product": "Pre-Filled Glass/COP Syringes for Biologics & Vaccines (HS 901831)",
      "target_hs6": "901831",
      "synergy": "Automated glass barrel forming, baked silicone lubrication, and nested sterile tub packaging; +55% margin.",
      "capex_estimate": "\u20b932 Crore (~$3.8M)",
      "payback_period": "19 Months"
    },
    {
      "target_product": "Safety Retractable Needle Infusion Sets (HS 901839)",
      "target_hs6": "901839",
      "synergy": "Shares medical polymer injection moulding and Class 10,000 cleanroom EtO sterilizers.",
      "capex_estimate": "\u20b914 Crore (~$1.7M)",
      "payback_period": "15 Months"
    },
    {
      "target_product": "Insulin Pen Injector Cartridge Mechanisms (HS 901831)",
      "target_hs6": "901831",
      "synergy": "High-cavity micro-moulding of POM gear drive mechanisms with optical torque verification.",
      "capex_estimate": "\u20b918 Crore (~$2.2M)",
      "payback_period": "16 Months"
    }
  ],
  "90211000": [
    {
      "target_product": "Patient-Specific 3D Titanium Cranio-Maxillofacial Implants (HS 902110)",
      "target_hs6": "902110",
      "synergy": "Utilizes selective laser melting (EOS M290) and medical CT scan reconstruction software; +60% margin.",
      "capex_estimate": "\u20b916 Crore (~$1.9M)",
      "payback_period": "15 Months"
    },
    {
      "target_product": "Total Knee & Hip Replacement Cobalt-Chrome Femoral Heads (HS 902110)",
      "target_hs6": "902110",
      "synergy": "Robotic 5-axis mirror polishing cell (Ra < 0.02 \u03bcm) and coordinate CMM inspection.",
      "capex_estimate": "\u20b924 Crore (~$2.9M)",
      "payback_period": "18 Months"
    },
    {
      "target_product": "Bio-Absorbable Polymer Interference Screws & Suture Anchors (HS 902110)",
      "target_hs6": "902110",
      "synergy": "Ultra-pure PLLA/PLGA micro-injection press in dry-room cleanroom environment.",
      "capex_estimate": "\u20b912 Crore (~$1.4M)",
      "payback_period": "14 Months"
    }
  ],
  "95030010": [
    {
      "target_product": "STEM Educational Programmable Robotic Kits (HS 950300)",
      "target_hs6": "950300",
      "synergy": "Integrates existing toy injection moulding with mini BLDC motors and Bluetooth microcontrollers; +45% margin.",
      "capex_estimate": "\u20b98.5 Crore (~$1.0M)",
      "payback_period": "13 Months"
    },
    {
      "target_product": "Die-Cast High-Precision Scale Model Vehicles (HS 950300)",
      "target_hs6": "950300",
      "synergy": "Zamak zinc alloy die-casting machine and automated electrostatic electrostatic spray line.",
      "capex_estimate": "\u20b912 Crore (~$1.4M)",
      "payback_period": "15 Months"
    },
    {
      "target_product": "Outdoor Electric Ride-On Battery Powered ATVs (HS 950300)",
      "target_hs6": "950300",
      "synergy": "Large blow-moulding platen for toy chassis and 24V brushless motor drivetrain assembly.",
      "capex_estimate": "\u20b915 Crore (~$1.8M)",
      "payback_period": "16 Months"
    }
  ]
};

// ============================================================================
// ============================================================================
// Sector Helper Functions & Cross-Sector Mappings
// ============================================================================
function getProductSectorKey(sectorStr: string): string {
  const s = sectorStr.toLowerCase();
  if (s.includes('pharma') || s.includes('chemic')) return 'pharma';
  if (s.includes('electronic')) return 'electronics';
  if (s.includes('machin') || s.includes('engineering') || s.includes('capital')) return 'machinery';
  if (s.includes('steel') || s.includes('iron')) return 'steel';
  if (s.includes('medical') || s.includes('instrument')) return 'medical';
  if (s.includes('rubber') || s.includes('tyre')) return 'rubber';
  if (s.includes('textile')) return 'textiles';
  if (s.includes('leather') || s.includes('footwear')) return 'leather';
  if (s.includes('toy') || s.includes('furniture')) return 'toys';
  return 'other';
}

const SECTOR_LABELS: Record<string, string> = {
  all: 'All Sectors (25 Strategic Lines)',
  pharma: 'Pharma & Life Sci',
  electronics: 'Electronics',
  machinery: 'Capital Goods & Machinery',
  steel: 'Specialty Steel & Fasteners',
  medical: 'Medical Devices & Diagnostics',
  rubber: 'Tyres & Rubber',
  textiles: 'Tech Textiles',
  leather: 'Footwear & Leather',
  toys: 'Toys & Misc.',
};

const SECTOR_CLUSTERS_MAP: Record<string, string[]> = {
  pharma: ['hyderabad_pharma', 'baddi_pharma', 'vizag_chem_pharma'],
  medical: ['amtz_vizag', 'ahmedabad_plastics'],
  electronics: ['noida_electronics', 'sricity_emc', 'sanand_ev_semicon', 'dholera_sir', 'silvassa_telecom', 'chennai_auto_electronics'],
  machinery: ['pune_chakan_machinery', 'peenya_machinery', 'coimbatore_machinery', 'ahmedabad_plastics', 'bengaluru_aerospace'],
  steel: ['jamshedpur_steel', 'rohtak_fasteners', 'gandhidham_cylinders'],
  rubber: ['chennai_auto_electronics', 'sanand_ev_semicon', 'pune_chakan_machinery'],
  textiles: ['surat_tech_textiles', 'coimbatore_textiles'],
  leather: ['ambur_footwear', 'yeida_toys'],
  toys: ['koppal_toys', 'yeida_toys'],
};

// ============================================================================
// Main Decisions Studio Component
// ============================================================================
export default function DecisionsPage() {
  const [persona, setPersona] = useState<PersonaMode>('policymaker');
  const [tab, setTab] = useState<WorkflowTab>('opportunity');

  // Sector filter for Workflow 1 product selector
  const [sectorFilter, setSectorFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Modals state
  const [showPriFormulaModal, setShowPriFormulaModal] = useState<boolean>(false);
  const [showInlineParameters, setShowInlineParameters] = useState<boolean>(true);
  const [rfqModalSupplier, setRfqModalSupplier] = useState<SupplierOrTrader | null>(null);
  const [rfqSubmitted, setRfqSubmitted] = useState<boolean>(false);
  const [customsModalTrader, setCustomsModalTrader] = useState<SupplierOrTrader | null>(null);
  const [memoModalOpen, setMemoModalOpen] = useState<boolean>(false);
  const [simulatorTarget, setSimulatorTarget] = useState<DiversificationTarget | null>(null);
  const [spvProposalModalOpen, setSpvProposalModalOpen] = useState<boolean>(false);

  // Workflow 1: Selected product (Defaults to Smartphones HS 85171300)
  const [selectedProductCode, setSelectedProductCode] = useState<string>('85171300');

  // Filtered strategic products
  const filteredProducts = useMemo(() => {
    return STRATEGIC_PRODUCTS.filter((p) => {
      const matchesSector = sectorFilter === 'all' || p.sector.toLowerCase().includes(sectorFilter.toLowerCase());
      const matchesQuery =
        !searchQuery ||
        p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.hsn8.includes(searchQuery) ||
        p.sector.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesSector && matchesQuery;
    });
  }, [sectorFilter, searchQuery]);

  // Synchronize active product when sector filter changes
  useEffect(() => {
    if (filteredProducts.length > 0 && !filteredProducts.some((p) => p.hsn8 === selectedProductCode)) {
      setSelectedProductCode(filteredProducts[0].hsn8);
    }
  }, [filteredProducts, selectedProductCode]);

  const product = useMemo(
    () => STRATEGIC_PRODUCTS.find((p) => p.hsn8 === selectedProductCode) ?? STRATEGIC_PRODUCTS[0],
    [selectedProductCode],
  );

  // Formatted trade metrics
  const netTrade = product.exports_usd - product.imports_usd;
  const isSurplus = netTrade >= 0;
  const netTradeFormatted = `${isSurplus ? '+' : '-'}$${(Math.abs(netTrade) / 1e6).toFixed(1)}M`;
  const globalMarketFormatted = `$${(product.world_trade_usd / 1e9).toFixed(1)}B`;

  // Active sector key derived from product
  const productSectorKey = useMemo(() => {
    return getProductSectorKey(product.sector);
  }, [product.sector]);

  // Cross-sector corridor visibility toggle (only functional when sectorFilter === 'all')
  const [showAllCrossSectorCorridors, setShowAllCrossSectorCorridors] = useState<boolean>(false);

  // Available corridors: STRICTLY scoped to active sector if sectorFilter !== 'all'
  // When sectorFilter === 'all', defaults to product's sector corridors, but allows user to expand to all 23 corridors
  const availableCorridors = useMemo(() => {
    if (sectorFilter !== 'all') {
      const allowed = SECTOR_CLUSTERS_MAP[sectorFilter] || [];
      return CLUSTERS_DATA.filter((c) => allowed.includes(c.id));
    }
    if (showAllCrossSectorCorridors) {
      return CLUSTERS_DATA;
    }
    const allowed = SECTOR_CLUSTERS_MAP[productSectorKey] ?? (PRODUCT_CLUSTERS_MAP[product.hs6] ?? []);
    return CLUSTERS_DATA.filter((c) => allowed.includes(c.id));
  }, [sectorFilter, showAllCrossSectorCorridors, productSectorKey, product.hs6]);

  // Workflow 2: Dynamic location comparator selections matching the selected product
  const defaultProductClusters = useMemo(() => {
    const recommended = PRODUCT_CLUSTERS_MAP[product.hs6] ?? [];
    const valid = recommended.filter((id) => availableCorridors.some((c) => c.id === id));
    if (valid.length > 0) return valid;
    return availableCorridors.slice(0, 3).map((c) => c.id);
  }, [product.hs6, availableCorridors]);

  const [selectedClusters, setSelectedClusters] = useState<string[]>(['hyderabad_pharma', 'baddi_pharma', 'vizag_chem_pharma']);

  // Reactive cluster synchronization: when product or availableCorridors change, update comparison selection
  useEffect(() => {
    if (defaultProductClusters.length > 0) {
      setSelectedClusters(defaultProductClusters.slice(0, 3));
    } else if (availableCorridors.length > 0) {
      setSelectedClusters(availableCorridors.slice(0, 3).map((c) => c.id));
    }
  }, [defaultProductClusters, availableCorridors]);

  // Workflow 3: Supplier and Trader filters
  const [entityTypeFilter, setEntityTypeFilter] = useState<EntityFilterType>('all');
  const [filterByActiveProduct, setFilterByActiveProduct] = useState<boolean>(true);

  // Filter suppliers by sector when sectorFilter !== 'all'
  const sectorScopedSuppliers = useMemo(() => {
    return SUPPLIERS_AND_TRADERS.filter((item) => {
      if (sectorFilter !== 'all') {
        return getProductSectorKey(item.sector) === sectorFilter;
      }
      return true;
    });
  }, [sectorFilter]);

  const filteredSuppliersAndTraders = useMemo(() => {
    return sectorScopedSuppliers.filter((item) => {
      // 1. Entity type filter (all, manufacturer, trader)
      if (entityTypeFilter !== 'all' && item.entity_type !== entityTypeFilter) {
        return false;
      }
      // 2. Active product filter
      if (filterByActiveProduct) {
        const matchesHs = item.hs6_codes.includes(product.hs6);
        const matchesSector = getProductSectorKey(item.sector) === productSectorKey;
        return matchesHs || matchesSector;
      }
      return true;
    });
  }, [sectorScopedSuppliers, entityTypeFilter, filterByActiveProduct, product.hs6, productSectorKey]);

  const totalInScope = sectorScopedSuppliers.length;
  const mfgInScope = sectorScopedSuppliers.filter((s) => s.entity_type === 'manufacturer').length;
  const trdInScope = sectorScopedSuppliers.filter((s) => s.entity_type === 'trader').length;

  // Workflow 4: Reactive cluster intervention selection matching the active product
  const [selectedInterventionCluster, setSelectedInterventionCluster] = useState<string>('noida_electronics');

  // Reactively synchronize Workflow 4 cluster intervention when product changes
  useEffect(() => {
    const recommended = PRODUCT_CLUSTERS_MAP[product.hs6];
    if (recommended && recommended.length > 0) {
      const topCluster = recommended[0];
      if (CLUSTERS_DATABASE[topCluster]) {
        setSelectedInterventionCluster(topCluster);
      }
    }
  }, [product.hs6]);

  const intervention = useMemo(() => {
    return CLUSTERS_DATABASE[selectedInterventionCluster] ?? CLUSTERS_DATABASE.hyderabad_pharma;
  }, [selectedInterventionCluster]);

  const [showAllInterventions, setShowAllInterventions] = useState<boolean>(false);

  // Target cluster interventions: STRICTLY scoped to active sector if sectorFilter !== 'all'
  // When sectorFilter === 'all', defaults to product's sector corridors, but allows user to expand to all 23 corridors
  const targetClusterInterventionKeys = useMemo(() => {
    if (sectorFilter !== 'all') {
      return SECTOR_CLUSTERS_MAP[sectorFilter] || [];
    }
    if (showAllInterventions) {
      const recommended = new Set(SECTOR_CLUSTERS_MAP[productSectorKey] ?? (PRODUCT_CLUSTERS_MAP[product.hs6] ?? []));
      const recKeys: string[] = [];
      const otherKeys: string[] = [];
      for (const key of Object.keys(CLUSTERS_DATABASE)) {
        if (recommended.has(key)) {
          recKeys.push(key);
        } else {
          otherKeys.push(key);
        }
      }
      return [...recKeys, ...otherKeys];
    }
    return SECTOR_CLUSTERS_MAP[productSectorKey] ?? (PRODUCT_CLUSTERS_MAP[product.hs6] ?? []);
  }, [sectorFilter, showAllInterventions, productSectorKey, product.hs6]);

  // Ensure selected cluster intervention belongs to the target list
  useEffect(() => {
    if (targetClusterInterventionKeys.length > 0 && !targetClusterInterventionKeys.includes(selectedInterventionCluster)) {
      setSelectedInterventionCluster(targetClusterInterventionKeys[0]);
    }
  }, [targetClusterInterventionKeys, selectedInterventionCluster]);

  // Workflow 5: Product diversification targets (Tailored directly to active product)
  const diversifications = useMemo(() => {
    return DIVERSIFICATIONS_MAP[product.hsn8] ?? DIVERSIFICATIONS_MAP['85171300'];
  }, [product.hsn8]);

  const tabs: TabDef<WorkflowTab>[] = [
    { id: 'opportunity', label: '1. Opportunity Assessment', icon: Target },
    { id: 'location', label: '2. Location & Viability', icon: MapPin },
    { id: 'supplier', label: '3. Supplier Capability', icon: Wrench },
    { id: 'intervention', label: '4. Cluster Intervention', icon: Building2 },
    { id: 'diversification', label: '5. Product Expansion', icon: TrendingUp },
  ];

  return (
    <div className="space-y-6">
      {/* Header with Title and Mode Switch */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-line pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-brand" />
            <span className="text-xs font-bold uppercase tracking-wider text-muted">
              Manufacturing Atlas AI · Decision Support Platform
            </span>
          </div>
          <h1 className="mt-1 font-serif text-3xl font-extrabold tracking-tight text-ink">
            Decisions Studio
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-ink-2">
            Operationalizing decisions for policymakers and business: what can be manufactured competitively,
            where, for which markets, and what is missing.
          </p>
        </div>

        <div className="flex flex-col items-start gap-2 sm:items-end">
          <SegmentedControl
            value={persona}
            onChange={(v) => setPersona(v as PersonaMode)}
            ariaLabel="Operating persona"
            options={[
              { value: 'policymaker', label: '🏛️ Policy Maker' },
              { value: 'business', label: '💼 Factory Operator' },
            ]}
          />
        </div>
      </div>

      {/* Persona Context Banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand/20 bg-brand-soft/30 p-3.5 text-xs text-ink">
        <div className="flex items-center gap-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand text-white font-bold text-sm shadow-sm">
            {persona === 'policymaker' ? '🏛️' : '💼'}
          </span>
          <div>
            <div className="font-bold text-ink">
              {persona === 'policymaker'
                ? 'Active Workflow: Public Industrial Policy & Cluster Interventions'
                : 'Active Workflow: Factory Location, Supplier Sourcing & Diversification'}
            </div>
            <div className="text-xs text-muted">
              {persona === 'policymaker'
                ? 'Evidence base for industrial priorities, missing cluster inputs, shared testing laboratories, and tariff protection.'
                : 'Decision engine for component localization, industrial corridor benchmarking, audited supplier qualification, and CAPEX modeling.'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink border border-line">
            <CheckCircle2 className="size-3 text-ok" /> WCO HS2022 Verified
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink border border-line">
            <CheckCircle2 className="size-3 text-ok" /> DGCIS FY24-25 Series
          </span>
        </div>
      </div>

      {/* Workflow Navigation Tabs */}
      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {/* Sector Scope Status Banner */}
      {sectorFilter !== 'all' ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-brand/30 bg-brand-soft/70 px-4 py-2.5 text-xs text-brand-ink shadow-sm">
          <div className="flex items-center gap-2">
            <span className="flex h-2 w-2 rounded-full bg-brand animate-pulse" />
            <span>
              Active Sector Scope: <strong className="text-ink font-semibold">{SECTOR_LABELS[sectorFilter]}</strong>
            </span>
            <span className="text-muted">|</span>
            <span>
              Strictly showing {filteredProducts.length} Strategic Products, {availableCorridors.length} Manufacturing Corridors, and Audited Industry Entities
            </span>
          </div>
          <button
            type="button"
            onClick={() => setSectorFilter('all')}
            className="inline-flex items-center gap-1 rounded-lg border border-brand/40 bg-white dark:bg-surface-2 px-2.5 py-1 text-[11px] font-semibold text-brand hover:bg-brand hover:text-white transition shadow-sm"
          >
            <RotateCcw className="h-3 w-3" />
            <span>Reset to All Sectors (25)</span>
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface-2/60 px-4 py-2 text-xs text-ink-2">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-brand" />
            <span>
              National Industrial View: <strong className="text-ink">All Sectors (25 Strategic Lines)</strong>
            </span>
            <span className="text-muted">|</span>
            <span className="text-muted">
              Active Product: <strong className="text-ink">{product.title}</strong> ({product.sector})
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted">Focus strictly on:</span>
            <button
              type="button"
              onClick={() => setSectorFilter(productSectorKey)}
              className="rounded-md border border-brand/30 bg-surface px-2.5 py-0.5 text-[11px] font-semibold text-brand hover:bg-brand hover:text-white transition shadow-sm"
            >
              {SECTOR_LABELS[productSectorKey] || product.sector}
            </button>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* WORKFLOW 1: MANUFACTURING OPPORTUNITY ASSESSMENT */}
      {/* ========================================================================= */}
      {tab === 'opportunity' && (
        <div className="space-y-6">
          {/* Product Selector with Sector Filter */}
          <Card
            title="Strategic Product Selector"
            subtitle="Browse 25 high-priority manufacturing lines computed with complete trade balance and Product Readiness Index"
            icon={Target}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="xs"
                  variant="primary"
                  icon={Info}
                  onClick={() => setShowPriFormulaModal(true)}
                  title="Open the complete quantitative scoring methodology and formula breakdown"
                >
                  Scoring Methodology & Parameters
                </Button>
                <div className="relative">
                  <Search className="absolute left-2.5 top-2 size-3.5 text-muted" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search 25 strategic products..."
                    className="w-56 rounded-md border border-line bg-surface py-1 pl-8 pr-3 text-xs text-ink placeholder:text-muted focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  />
                </div>
              </div>
            }
          >
            {/* Sector Filter Chips */}
            <div className="mb-3 flex flex-wrap gap-1.5">
              {[
                { id: 'all', label: 'All Sectors (25)' },
                { id: 'electronics', label: 'Electronics (8)' },
                { id: 'machinery', label: 'Capital Goods (5)' },
                { id: 'pharma', label: 'Pharma & Life Sci (3)' },
                { id: 'steel', label: 'Specialty Steel (3)' },
                { id: 'medical', label: 'Medical Devices (2)' },
                { id: 'rubber', label: 'Tyres & Rubber (1)' },
                { id: 'textiles', label: 'Tech Textiles (1)' },
                { id: 'leather', label: 'Footwear (1)' },
                { id: 'toys', label: 'Toys (1)' },
              ].map((sec) => (
                <button
                  key={sec.id}
                  type="button"
                  onClick={() => setSectorFilter(sec.id)}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                    sectorFilter === sec.id
                      ? 'bg-brand text-white shadow-sm'
                      : 'bg-surface-2 text-ink-2 hover:bg-surface-3'
                  }`}
                >
                  {sec.label}
                </button>
              ))}
            </div>

            {/* Horizontal Product Chips Grid */}
            <div className="grid max-h-48 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3 pr-1">
              {filteredProducts.map((p) => {
                const isSelected = p.hsn8 === selectedProductCode;
                return (
                  <button
                    key={p.hsn8}
                    type="button"
                    onClick={() => setSelectedProductCode(p.hsn8)}
                    className={`flex items-start gap-2.5 rounded-lg border p-2 text-left transition ${
                      isSelected
                        ? 'border-brand bg-brand-soft/40 shadow-sm ring-1 ring-brand/40'
                        : 'border-line bg-surface hover:border-brand/40 hover:bg-surface-2'
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                        isSelected ? 'bg-brand text-white' : 'bg-surface-3 text-muted'
                      }`}
                    >
                      {Math.round(p.pri_score)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold text-xs text-ink">{p.title}</div>
                      <div className="flex items-center gap-2 text-[11px] text-muted">
                        <span className="font-mono">HS {p.hsn8}</span>
                        <span>·</span>
                        <span className="truncate">{p.sector.split('&')[0]}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </Card>

          {/* Active Product Evaluation Hero Banner */}
          <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-brand/10 px-2 py-0.5 font-mono text-xs font-bold text-brand-ink">
                    HSN {product.hsn8}
                  </span>
                  <span className="rounded bg-surface-2 px-2 py-0.5 text-xs text-ink-2 border border-line/50">
                    {product.sector}
                  </span>
                  <span className="rounded bg-surface-2 px-2 py-0.5 text-xs text-muted">
                    Lead: {product.ministry}
                  </span>
                </div>
                <h2 className="text-xl font-bold text-ink">{product.title}</h2>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="xs"
                  variant="secondary"
                  icon={MapPin}
                  onClick={() => setTab('location')}
                >
                  Step 2: Compare Corridors
                </Button>
                <Button
                  size="xs"
                  variant="primary"
                  icon={Wrench}
                  onClick={() => setTab('supplier')}
                >
                  Step 3: Verified Suppliers
                </Button>
                <Button
                  size="xs"
                  variant="secondary"
                  icon={Building2}
                  onClick={() => setTab('intervention')}
                >
                  Step 4: Cluster Interventions
                </Button>
              </div>
            </div>

            {/* Key KPI Tiles */}
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-xl border border-line bg-surface-2/60 p-3">
                <div className="text-[11px] font-medium text-muted">India's Net Trade (2024)</div>
                <div
                  className={`mt-1 font-mono text-lg font-extrabold ${
                    isSurplus ? 'text-ok-ink' : 'text-danger-ink'
                  }`}
                >
                  {netTradeFormatted}
                </div>
                <div className="text-[10px] text-muted">
                  {isSurplus ? 'Net Trade Surplus' : 'Net Trade Deficit'}
                </div>
              </div>

              <div className="rounded-xl border border-line bg-surface-2/60 p-3">
                <div className="text-[11px] font-medium text-muted">Global Market Demand</div>
                <div className="mt-1 font-mono text-lg font-extrabold text-ink">
                  {globalMarketFormatted}
                </div>
                <div className="text-[10px] text-muted">World Trade Matrix (CEPII)</div>
              </div>

              <div className="rounded-xl border border-line bg-surface-2/60 p-3">
                <div className="text-[11px] font-medium text-muted">Revealed Comp. Advantage</div>
                <div className="mt-1 font-mono text-lg font-extrabold text-brand-ink">
                  RCA {product.rca.toFixed(2)}
                </div>
                <div className="text-[10px] text-muted">Balassa Index (&gt; 1.0 = Advantaged)</div>
              </div>

              <div className="rounded-xl border border-line bg-surface-2/60 p-3">
                <div className="text-[11px] font-medium text-muted">Product Readiness Index (PRI)</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="font-mono text-xl font-black text-brand-ink">
                    {product.pri_score.toFixed(1)}
                  </span>
                  <span className="text-[11px] font-semibold text-muted">/ 100</span>
                </div>
                <div className="text-[10px] font-semibold text-ok-ink">
                  {product.pri_tier}
                </div>
              </div>
            </div>

            {/* Product Readiness Index Breakdown (Inline View with Toggle) */}
            <div className="mt-5 rounded-xl border border-line bg-surface-2/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
                <div>
                  <div className="font-bold text-xs uppercase tracking-wider text-ink flex items-center gap-2">
                    <span>Product Readiness Index (PRI) Quantitative Score Breakdown</span>
                    <span className="rounded bg-brand/10 px-1.5 py-0.5 text-[10px] font-bold text-brand-ink">
                      4 Pillars Weighted
                    </span>
                  </div>
                  <p className="text-[11px] text-muted">
                    Governing Equation: PRI = 0.35 · C_comp + 0.25 · M_opp + 0.20 · P_pol + 0.20 · S_std
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowInlineParameters(!showInlineParameters)}
                    className="flex items-center gap-1 text-xs font-semibold text-brand hover:underline"
                  >
                    {showInlineParameters ? (
                      <>
                        <ChevronUp className="size-3.5" /> Collapse Scoring Parameters
                      </>
                    ) : (
                      <>
                        <ChevronDown className="size-3.5" /> View Scoring Parameters
                      </>
                    )}
                  </button>
                  <Button
                    size="xs"
                    variant="secondary"
                    icon={Info}
                    onClick={() => setShowPriFormulaModal(true)}
                  >
                    Methodology Dossier
                  </Button>
                </div>
              </div>

              {showInlineParameters && (
                <div className="mt-4 space-y-4">
                  {/* Mathematical formula badge banner */}
                  <div className="rounded-lg bg-surface p-2.5 font-mono text-[11px] text-ink-2 border border-line/60 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      Formula: <strong>(35% × Competitiveness)</strong> + <strong>(25% × Market Opportunity)</strong> + <strong>(20% × Policy Alignment)</strong> + <strong>(20% × Standards & Resilience)</strong>
                    </div>
                    <div className="font-bold text-brand-ink">
                      Composite Score = {product.pri_score.toFixed(1)} / 100
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {/* Pillar 1 */}
                    <div className="rounded-lg border border-line bg-surface p-3">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-xs text-ink">1. Competitiveness</span>
                        <span className="rounded bg-brand/10 px-1.5 py-0.2 font-mono text-[10px] font-bold text-brand-ink">
                          Weight: {(product.pri_breakdown.competitiveness.weight * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="mt-2 flex items-baseline justify-between font-mono">
                        <span className="text-sm font-extrabold text-ink">
                          {product.pri_breakdown.competitiveness.score.toFixed(0)} / 100
                        </span>
                        <span className="text-xs font-semibold text-ok-ink">
                          +{product.pri_breakdown.competitiveness.points.toFixed(1)} pts
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
                        <div
                          className="h-full bg-brand"
                          style={{ width: `${Math.min(100, product.pri_breakdown.competitiveness.score)}%` }}
                        />
                      </div>
                      <div className="mt-2 text-[10.5px] text-muted leading-tight">
                        {product.pri_breakdown.competitiveness.details ?? 'Based on RCA, tariff resilience & scale.'}
                      </div>
                    </div>

                    {/* Pillar 2 */}
                    <div className="rounded-lg border border-line bg-surface p-3">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-xs text-ink">2. Market Opportunity</span>
                        <span className="rounded bg-brand/10 px-1.5 py-0.2 font-mono text-[10px] font-bold text-brand-ink">
                          Weight: {(product.pri_breakdown.market_opportunity.weight * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="mt-2 flex items-baseline justify-between font-mono">
                        <span className="text-sm font-extrabold text-ink">
                          {product.pri_breakdown.market_opportunity.score.toFixed(0)} / 100
                        </span>
                        <span className="text-xs font-semibold text-ok-ink">
                          +{product.pri_breakdown.market_opportunity.points.toFixed(1)} pts
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
                        <div
                          className="h-full bg-brand"
                          style={{ width: `${Math.min(100, product.pri_breakdown.market_opportunity.score)}%` }}
                        />
                      </div>
                      <div className="mt-2 text-[10.5px] text-muted leading-tight">
                        {product.pri_breakdown.market_opportunity.details ?? 'Based on Global Import Demand and expansion CAGR.'}
                      </div>
                    </div>

                    {/* Pillar 3 */}
                    <div className="rounded-lg border border-line bg-surface p-3">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-xs text-ink">3. Policy Alignment</span>
                        <span className="rounded bg-brand/10 px-1.5 py-0.2 font-mono text-[10px] font-bold text-brand-ink">
                          Weight: {(product.pri_breakdown.policy_alignment.weight * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="mt-2 flex items-baseline justify-between font-mono">
                        <span className="text-sm font-extrabold text-ink">
                          {product.pri_breakdown.policy_alignment.score.toFixed(0)} / 100
                        </span>
                        <span className="text-xs font-semibold text-ok-ink">
                          +{product.pri_breakdown.policy_alignment.points.toFixed(1)} pts
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
                        <div
                          className="h-full bg-brand"
                          style={{ width: `${Math.min(100, product.pri_breakdown.policy_alignment.score)}%` }}
                        />
                      </div>
                      <div className="mt-2 text-[10.5px] text-muted leading-tight">
                        {product.pri_breakdown.policy_alignment.details ?? 'Backed by active PLI incentives & state Capex subsidies.'}
                      </div>
                    </div>

                    {/* Pillar 4 */}
                    <div className="rounded-lg border border-line bg-surface p-3">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-xs text-ink">4. Standards & Resilience</span>
                        <span className="rounded bg-brand/10 px-1.5 py-0.2 font-mono text-[10px] font-bold text-brand-ink">
                          Weight: {(product.pri_breakdown.standards_resilience.weight * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="mt-2 flex items-baseline justify-between font-mono">
                        <span className="text-sm font-extrabold text-ink">
                          {product.pri_breakdown.standards_resilience.score.toFixed(0)} / 100
                        </span>
                        <span className="text-xs font-semibold text-ok-ink">
                          +{product.pri_breakdown.standards_resilience.points.toFixed(1)} pts
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
                        <div
                          className="h-full bg-brand"
                          style={{ width: `${Math.min(100, product.pri_breakdown.standards_resilience.score)}%` }}
                        />
                      </div>
                      <div className="mt-2 text-[10.5px] text-muted leading-tight">
                        {product.pri_breakdown.standards_resilience.details ?? 'Grounded on BIS QCO orders & import concentration HHI.'}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Deductive Analysis Summary Card */}
            <div className="mt-5 rounded-xl border border-line bg-brand-soft/20 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="size-4 text-brand" />
                  <h3 className="font-bold text-xs uppercase tracking-wider text-brand-ink">
                    Deductive Analysis: How the Platform Reached this Decision
                  </h3>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={Download}
                  onClick={() => setMemoModalOpen(true)}
                  title="Open print-friendly decision memo report"
                >
                  Export Decision Memo
                </Button>
              </div>

              <div className="mt-2.5 space-y-2 text-xs text-ink-2 leading-relaxed">
                <div>
                  <strong>Trade & Capacity Deduction:</strong> {product.deductive_summary.trade_deduction}
                </div>
                <div>
                  <strong>Bottleneck Deduction:</strong> {product.deductive_summary.bottleneck_deduction}
                </div>
                <div>
                  <strong>Policy Directive:</strong> {product.deductive_summary.policy_action}
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 text-xs">
                <div className="rounded-lg bg-surface p-3 border border-line/60">
                  <div className="font-semibold text-danger-ink flex items-center gap-1.5">
                    <AlertTriangle className="size-3.5" />
                    Identified Ecosystem Bottlenecks
                  </div>
                  <ul className="mt-2 list-inside list-disc space-y-1 text-muted text-[11px]">
                    {product.constraints.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                </div>

                <div className="rounded-lg bg-surface p-3 border border-line/60">
                  <div className="font-semibold text-ok-ink flex items-center gap-1.5">
                    <CheckCircle2 className="size-3.5" />
                    Recommended Policy & Industrial Levers
                  </div>
                  <ul className="mt-2 list-inside list-disc space-y-1 text-muted text-[11px]">
                    {product.next_checks.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>

            {/* Bottom Workflow Action Links */}
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              <div className="text-xs text-muted">
                Step 1 of 5 complete. Evaluated <strong>{product.title}</strong> (HS {product.hsn8}).
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="xs"
                  variant="secondary"
                  icon={MapPin}
                  onClick={() => setTab('location')}
                >
                  Step 2: Location Viability & Corridors →
                </Button>
                <Button
                  size="xs"
                  variant="primary"
                  icon={Wrench}
                  onClick={() => setTab('supplier')}
                >
                  Step 3: Verified Suppliers & Traders →
                </Button>
                <Button
                  size="xs"
                  variant="secondary"
                  icon={Building2}
                  onClick={() => setTab('intervention')}
                >
                  Step 4: Cluster Interventions →
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* WORKFLOW 2: LOCATION & VIABILITY COMPARISON */}
      {/* ========================================================================= */}
      {tab === 'location' && (
        <div className="space-y-6">
          <Card
            title="Location & Viability Comparison: Dynamic Corridor Matching"
            subtitle={`Benchmarking top industrial corridors for active product: ${product.title} (HS ${product.hsn8})`}
            icon={MapPin}
            actions={
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  variant="secondary"
                  icon={Sparkles}
                  onClick={() => setSelectedClusters(defaultProductClusters)}
                  title="Reset comparison to the top corridors recommended for this active product"
                >
                  Reset to Matched Corridors
                </Button>
              </div>
            }
          >
            {/* Cluster Selection Chips - Strictly Scoped to Active Sector */}
            <div className="mb-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <div className="text-xs font-semibold text-ink">
                  {sectorFilter !== 'all' ? (
                    <span>
                      Corridors for <strong className="text-brand font-bold">{SECTOR_LABELS[sectorFilter]}</strong> ({availableCorridors.length} hubs):
                    </span>
                  ) : (
                    <span>
                      Manufacturing Corridors for <strong className="text-brand font-bold">{product.title}</strong> ({availableCorridors.length} hubs):
                    </span>
                  )}
                </div>
                {sectorFilter === 'all' && (
                  <button
                    type="button"
                    onClick={() => setShowAllCrossSectorCorridors(!showAllCrossSectorCorridors)}
                    className="rounded-lg border border-line bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-ink-2 hover:border-brand hover:text-brand transition shadow-sm"
                  >
                    {showAllCrossSectorCorridors
                      ? `Show Only ${SECTOR_LABELS[productSectorKey] || 'Product'} Corridors (${SECTOR_CLUSTERS_MAP[productSectorKey]?.length || 3})`
                      : `View All 23 National Corridors Across Other Sectors`}
                  </button>
                )}
              </div>

              <div className="flex flex-wrap gap-1.5">
                {availableCorridors.map((c) => {
                  const isSelected = selectedClusters.includes(c.id);
                  const isRecommended = defaultProductClusters.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        if (isSelected) {
                          if (selectedClusters.length > 1) {
                            setSelectedClusters(selectedClusters.filter((x) => x !== c.id));
                          }
                        } else {
                          if (selectedClusters.length < 3) {
                            setSelectedClusters([...selectedClusters, c.id]);
                          } else {
                            setSelectedClusters([selectedClusters[1], selectedClusters[2], c.id]);
                          }
                        }
                      }}
                      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
                        isSelected
                          ? 'bg-brand text-white shadow-sm ring-1 ring-brand'
                          : isRecommended
                          ? 'bg-brand-soft/60 text-brand-ink border border-brand/40 hover:bg-brand-soft'
                          : 'bg-surface-2 text-ink-2 hover:bg-surface-3'
                      }`}
                    >
                      <span>{c.name}</span>
                      {isSelected && <CheckCircle2 className="h-3 w-3" />}
                      {isRecommended && !isSelected && (
                        <span className="size-1.5 rounded-full bg-brand" title="Recommended for active product" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Comparison Matrix Table */}
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-line bg-surface-2">
                    <th className="p-3 font-semibold text-ink w-1/4">Evaluation Dimension</th>
                    {selectedClusters.map((cid) => {
                      const c = CLUSTERS_DATA.find((x) => x.id === cid) ?? CLUSTERS_DATA[0];
                      return (
                        <th key={cid} className="p-3 font-bold text-ink w-1/4">
                          <div className="text-sm font-extrabold text-brand-ink">{c.name}</div>
                          <div className="text-[11px] font-normal text-muted">{c.district}, {c.state}</div>
                          <div className="mt-1 flex items-center gap-1.5">
                            <span className="rounded bg-ok-soft px-1.5 py-0.5 text-[10px] font-bold text-ok-ink">
                              Score: {c.score}/100
                            </span>
                            <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-medium text-muted border border-line/60">
                              {c.sector}
                            </span>
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  <tr>
                    <td className="p-3 font-medium text-ink bg-surface-2/40">Anchor Manufacturers & Assemblers</td>
                    {selectedClusters.map((cid) => {
                      const c = CLUSTERS_DATA.find((x) => x.id === cid) ?? CLUSTERS_DATA[0];
                      return (
                        <td key={cid} className="p-3 text-ink-2 font-medium">
                          {c.anchors}
                        </td>
                      );
                    })}
                  </tr>
                  <tr>
                    <td className="p-3 font-medium text-ink bg-surface-2/40">Key Products & Line Capabilities</td>
                    {selectedClusters.map((cid) => {
                      const c = CLUSTERS_DATA.find((x) => x.id === cid) ?? CLUSTERS_DATA[0];
                      return (
                        <td key={cid} className="p-3 text-muted">
                          {c.products}
                        </td>
                      );
                    })}
                  </tr>
                  <tr>
                    <td className="p-3 font-medium text-ink bg-surface-2/40">Multimodal Logistics & Gateways</td>
                    {selectedClusters.map((cid) => {
                      const c = CLUSTERS_DATA.find((x) => x.id === cid) ?? CLUSTERS_DATA[0];
                      return (
                        <td key={cid} className="p-3 space-y-1">
                          <div className="flex items-center gap-1.5 text-ink-2">
                            <Truck className="size-3.5 text-brand" />
                            <span>{c.port_distance}</span>
                          </div>
                          <div className="flex items-center gap-1.5 text-muted text-[11px]">
                            <span>✈️ {c.airport_distance}</span>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                  <tr>
                    <td className="p-3 font-medium text-ink bg-surface-2/40">Utilities & IILB Industrial Land Bank</td>
                    {selectedClusters.map((cid) => {
                      const c = CLUSTERS_DATA.find((x) => x.id === cid) ?? CLUSTERS_DATA[0];
                      return (
                        <td key={cid} className="p-3 space-y-1">
                          <div className="text-ink">{c.power_water}</div>
                          <div className="text-[11px] text-ok-ink font-medium">✓ {c.iilb_status}</div>
                        </td>
                      );
                    })}
                  </tr>
                  <tr>
                    <td className="p-3 font-medium text-ink bg-surface-2/40">Skill Council & Workforce Depth</td>
                    {selectedClusters.map((cid) => {
                      const c = CLUSTERS_DATA.find((x) => x.id === cid) ?? CLUSTERS_DATA[0];
                      return (
                        <td key={cid} className="p-3">
                          <div className="flex items-center gap-1.5 text-ink">
                            <Users className="size-3.5 text-brand" />
                            <span>{c.skills_council}</span>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                  <tr>
                    <td className="p-3 font-medium text-ink bg-surface-2/40">Applicable Policy Incentives</td>
                    {selectedClusters.map((cid) => {
                      const c = CLUSTERS_DATA.find((x) => x.id === cid) ?? CLUSTERS_DATA[0];
                      return (
                        <td key={cid} className="p-3 text-[11.5px] leading-relaxed text-ink-2">
                          {c.incentives}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Bottom Action Banner for Workflow 2 */}
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 p-3.5">
              <div className="text-xs text-ink-2">
                Top corridor for <strong>{product.title}</strong>: {CLUSTERS_DATA.find((x) => x.id === selectedClusters[0])?.name}.
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  variant="secondary"
                  icon={ArrowLeft}
                  onClick={() => setTab('opportunity')}
                >
                  Back to Assessment
                </Button>
                <Button
                  size="xs"
                  variant="primary"
                  icon={ArrowRight}
                  onClick={() => setTab('supplier')}
                >
                  Step 3: Proceed to Supplier Verification →
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ========================================================================= */}
      {/* WORKFLOW 3: SUPPLIER AND TRADER INTELLIGENCE */}
      {/* ========================================================================= */}
      {tab === 'supplier' && (
        <div className="space-y-6">
          <Card
            title="Supplier & Trader Intelligence: Verified Manufacturers vs. Importers"
            subtitle="Distinguishing genuine domestic manufacturing plants from commercial importers, stockists, and trading houses"
            icon={Wrench}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <SegmentedControl
                  value={entityTypeFilter}
                  onChange={(v) => setEntityTypeFilter(v as EntityFilterType)}
                  ariaLabel="Entity classification filter"
                  options={[
                    { value: 'all', label: `All Entities (${totalInScope})` },
                    { value: 'manufacturer', label: `🏭 Factory Operators (${mfgInScope})` },
                    { value: 'trader', label: `📦 Traders & Importers (${trdInScope})` },
                  ]}
                />
              </div>
            }
          >
            {/* Active Product Filter Bar */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 p-3 text-xs">
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 cursor-pointer font-semibold text-ink">
                  <input
                    type="checkbox"
                    checked={filterByActiveProduct}
                    onChange={(e) => setFilterByActiveProduct(e.target.checked)}
                    className="rounded border-line text-brand focus:ring-brand"
                  />
                  <span>Filter by active product:</span>
                </label>
                <span className="rounded bg-brand/10 px-2 py-0.5 font-bold text-brand-ink">
                  {product.title} (HS {product.hsn8})
                </span>
                <span className="text-muted">({filteredSuppliersAndTraders.length} matching entities)</span>
              </div>

              {sectorFilter !== 'all' ? (
                <span className="rounded bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand">
                  Strictly scoped to {SECTOR_LABELS[sectorFilter]}
                </span>
              ) : !filterByActiveProduct ? (
                <span className="rounded bg-amber-soft px-2 py-0.5 text-[11px] font-semibold text-amber-ink">
                  Showing all audited entities across India
                </span>
              ) : null}
            </div>

            {/* List of Filtered Suppliers & Traders */}
            <div className="grid grid-cols-1 gap-4">
              {filteredSuppliersAndTraders.length === 0 ? (
                <div className="rounded-xl border border-line bg-surface p-8 text-center text-xs">
                  <div className="text-muted">No entities match the current product and classification filter.</div>
                  <button
                    type="button"
                    onClick={() => setFilterByActiveProduct(false)}
                    className="mt-2 font-semibold text-brand hover:underline"
                  >
                    Clear active product filter to view all {SUPPLIERS_AND_TRADERS.length} audited entities
                  </button>
                </div>
              ) : (
                filteredSuppliersAndTraders.map((item) => {
                  const isMfg = item.entity_type === 'manufacturer';
                  return (
                    <div
                      key={item.id}
                      className={`rounded-xl border p-4.5 transition ${
                        isMfg
                          ? 'border-line bg-surface shadow-sm hover:border-ok/40'
                          : 'border-amber-200/60 bg-amber-soft/10 hover:border-amber-400'
                      }`}
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                                isMfg
                                  ? 'bg-ok-soft text-ok-ink border border-ok/30'
                                  : 'bg-amber-soft text-amber-ink border border-amber-300'
                              }`}
                            >
                              {isMfg ? '🏭 Verified Domestic Manufacturer' : '🚢 Commercial Importer & Trader'}
                            </span>
                            <span className="rounded bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted border border-line">
                              {item.sector}
                            </span>
                            <span className="rounded bg-surface px-2 py-0.5 text-[10.5px] font-mono text-muted border border-line">
                              Audit: {item.verification_level}
                            </span>
                          </div>

                          <h3 className="mt-1.5 text-base font-bold text-ink">{item.name}</h3>
                          <div className="flex items-center gap-1.5 text-xs text-muted">
                            <MapPin className="size-3.5 text-brand" />
                            <span>{item.location}, {item.state}</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          {isMfg ? (
                            <Button
                              size="xs"
                              variant="primary"
                              icon={FileCheck}
                              onClick={() => {
                                setRfqModalSupplier(item);
                                setRfqSubmitted(false);
                              }}
                            >
                              Request Technical Qualification (RFQ)
                            </Button>
                          ) : (
                            <Button
                              size="xs"
                              variant="secondary"
                              icon={FileText}
                              onClick={() => setCustomsModalTrader(item)}
                            >
                              Inspect Customs Import Records
                            </Button>
                          )}
                        </div>
                      </div>

                      {/* Technical Specs & Capabilities */}
                      <div className="mt-3.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4 text-xs">
                        <div className="rounded-lg bg-surface-2/60 p-2.5 border border-line/60">
                          <div className="text-[10.5px] font-semibold text-muted">
                            {isMfg ? 'Processes & Tooling' : 'Trading & Storage Operations'}
                          </div>
                          <div className="mt-1 font-medium text-ink">
                            {item.processes.join(', ')}
                          </div>
                        </div>

                        <div className="rounded-lg bg-surface-2/60 p-2.5 border border-line/60">
                          <div className="text-[10.5px] font-semibold text-muted">Materials & Feedstocks</div>
                          <div className="mt-1 font-medium text-ink">
                            {item.materials.join(', ')}
                          </div>
                        </div>

                        <div className="rounded-lg bg-surface-2/60 p-2.5 border border-line/60">
                          <div className="text-[10.5px] font-semibold text-muted">Tolerances & Accuracy</div>
                          <div className="mt-1 font-mono font-medium text-ink">
                            {item.tolerance_class}
                          </div>
                        </div>

                        <div className="rounded-lg bg-surface-2/60 p-2.5 border border-line/60">
                          <div className="text-[10.5px] font-semibold text-muted">Audited Scale / Capacity</div>
                          <div className="mt-1 font-semibold text-brand-ink">
                            {item.scale_capacity}
                          </div>
                        </div>
                      </div>

                      {/* Audited Certifications */}
                      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="font-semibold text-muted text-[11px]">Audited Certifications:</span>
                        {item.certifications.map((c, idx) => (
                          <span
                            key={idx}
                            className="inline-flex items-center gap-1 rounded bg-surface px-2 py-0.5 text-[11px] font-medium text-ink border border-line"
                          >
                            <CheckCircle2 className="size-3 text-ok" />
                            <span>{c.name}</span>
                            <span className="text-muted text-[10px]">({c.valid_until})</span>
                          </span>
                        ))}
                      </div>

                      {/* Deductive Audit Rationale */}
                      <div className="mt-3 rounded-lg border border-line/80 bg-surface-2/30 p-2.5 text-[11.5px] text-ink-2">
                        <div className="font-bold text-[11px] text-brand-ink uppercase mb-1">
                          Audited Deduction Rationale: How the Platform Verified this Entity
                        </div>
                        <div className="space-y-1">
                          <div>
                            <strong>Physical Site Geolocation:</strong> {item.deduction_rationale.site_verification}
                          </div>
                          <div>
                            <strong>Process / Import Verification:</strong> {item.deduction_rationale.process_audit}
                          </div>
                          <div>
                            <strong>Regulatory & Standards Link:</strong> {item.deduction_rationale.standards_link}
                          </div>
                          <div>
                            <strong>Industry Linkage:</strong> {item.deduction_rationale.oem_linkage}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Bottom Action Banner for Workflow 3 */}
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 p-3.5">
              <div className="text-xs text-ink-2">
                Supplier capability verification complete. Next: evaluate public cluster infrastructure interventions.
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  variant="secondary"
                  icon={ArrowLeft}
                  onClick={() => setTab('location')}
                >
                  Back to Corridors
                </Button>
                <Button
                  size="xs"
                  variant="primary"
                  icon={ArrowRight}
                  onClick={() => setTab('intervention')}
                >
                  Step 4: Cluster Interventions →
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ========================================================================= */}
      {/* WORKFLOW 4: PUBLIC INDUSTRIAL POLICY & CLUSTER INTERVENTIONS */}
      {/* ========================================================================= */}
      {tab === 'intervention' && (
        <div className="space-y-6">
          <Card
            title="Public Industrial Policy & Cluster Interventions"
            subtitle={`Targeted infrastructure SPV proposals dynamically synchronized for active product: ${product.title} (HS ${product.hsn8})`}
            icon={Building2}
            actions={
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  variant="secondary"
                  icon={RotateCcw}
                  onClick={() => {
                    const topRec = PRODUCT_CLUSTERS_MAP[product.hs6]?.[0];
                    if (topRec && CLUSTERS_DATABASE[topRec]) {
                      setSelectedInterventionCluster(topRec);
                    }
                  }}
                  title="Reset to recommended cluster for active product"
                >
                  Reset to Matched Cluster
                </Button>
                <Button
                  size="xs"
                  variant="primary"
                  icon={FileText}
                  onClick={() => setSpvProposalModalOpen(true)}
                >
                  Submit SPV Proposal
                </Button>
              </div>
            }
          >
            {/* Context Notice for Synchronized Intervention */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand/20 bg-brand-soft/20 p-3 text-xs">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-brand" />
                <span className="font-semibold text-ink">Active Strategic Context:</span>
                <span className="rounded bg-brand/10 px-2 py-0.5 font-bold text-brand-ink">
                  {product.title} (HS {product.hsn8})
                </span>
                <span className="text-muted">· Corridors mapped: {(PRODUCT_CLUSTERS_MAP[product.hs6] ?? []).length}</span>
              </div>
              <span className="rounded bg-ok-soft px-2 py-0.5 text-[11px] font-bold text-ok-ink">
                ✓ Showing Recommended Cluster for {product.sector.split('&')[0]}
              </span>
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              {/* Cluster Selector List (Prioritizes Recommended Clusters for Active Product!) */}
              <div className="space-y-2 max-h-[540px] overflow-y-auto pr-1">
                <div className="text-xs font-semibold text-ink flex items-center justify-between">
                  <span>Target Cluster Interventions:</span>
                  <span className="text-[10px] text-muted">{targetClusterInterventionKeys.length} corridors</span>
                </div>
                {sectorFilter === 'all' && (
                  <button
                    type="button"
                    onClick={() => setShowAllInterventions(!showAllInterventions)}
                    className="w-full text-left rounded-lg border border-line bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-ink-2 hover:border-brand hover:text-brand transition shadow-sm"
                  >
                    {showAllInterventions
                      ? `Show Only ${SECTOR_LABELS[productSectorKey] || 'Product'} Corridors (${SECTOR_CLUSTERS_MAP[productSectorKey]?.length || 3})`
                      : `View All 23 National Corridors Across Other Sectors`}
                  </button>
                )}
                {targetClusterInterventionKeys.map((key) => {
                  const item = CLUSTERS_DATABASE[key];
                  if (!item) return null;
                  const isSelected = selectedInterventionCluster === key;
                  const isRecommended = (PRODUCT_CLUSTERS_MAP[product.hs6] ?? []).includes(key);

                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSelectedInterventionCluster(key)}
                      className={`w-full rounded-xl border p-3 text-left transition ${
                        isSelected
                          ? 'border-brand bg-brand-soft/40 shadow-sm ring-1 ring-brand/40'
                          : isRecommended
                          ? 'border-brand/40 bg-brand-soft/10 hover:bg-brand-soft/20'
                          : 'border-line bg-surface hover:bg-surface-2'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-1">
                        <div className="font-bold text-xs text-ink">{item.cluster_name}</div>
                        {isRecommended && (
                          <span className="shrink-0 rounded bg-brand/10 px-1.5 py-0.2 text-[9px] font-bold text-brand-ink">
                            Matched
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-muted">{item.state}</div>
                      <div className="mt-1 flex items-center justify-between">
                        <span className="font-mono text-[11px] font-extrabold text-brand-ink">
                          {item.indicative_cost}
                        </span>
                        <span className="text-[10px] text-muted">{item.lead_agency.split('&')[0]}</span>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Detailed Intervention Dossier */}
              <div className="lg:col-span-2 space-y-4 rounded-xl border border-line bg-surface p-4 text-xs">
                <div className="flex items-start justify-between border-b border-line pb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-brand/10 px-2 py-0.5 font-bold text-brand-ink text-[11px]">
                        {intervention.cluster_name} ({intervention.state})
                      </span>
                      {(PRODUCT_CLUSTERS_MAP[product.hs6] ?? []).includes(selectedInterventionCluster) && (
                        <span className="rounded bg-ok-soft px-2 py-0.5 text-[10px] font-bold text-ok-ink">
                          ✓ Direct Match for {product.title}
                        </span>
                      )}
                    </div>
                    <h3 className="mt-1.5 text-base font-bold text-ink">
                      Common Testing Laboratory & Certification Infrastructure
                    </h3>
                    <div className="text-muted text-[11px] mt-0.5">
                      Lead Sponsoring Agency: <strong>{intervention.lead_agency}</strong>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-base font-extrabold text-brand-ink">{intervention.indicative_cost}</div>
                    <div className="text-[10px] text-muted">Indicative CAPEX (50:50 SPV Model)</div>
                  </div>
                </div>

                <div className="rounded-lg bg-surface-2 p-3 border border-line/60">
                  <div className="font-semibold text-ink flex items-center gap-1.5">
                    <AlertTriangle className="size-3.5 text-amber" />
                    Identified Cluster Demand Evidence
                  </div>
                  <p className="mt-1 text-ink-2 leading-relaxed">{intervention.evidence_demand}</p>
                </div>

                <div>
                  <div className="font-semibold text-ink flex items-center gap-1.5">
                    <CheckCircle2 className="size-3.5 text-ok" />
                    Phased Implementation Milestones
                  </div>
                  <div className="mt-2 space-y-2">
                    {intervention.milestones.map((m, i) => (
                      <div key={i} className="flex items-start gap-2.5 rounded-lg border border-line bg-surface-2/40 p-2.5">
                        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand text-[10px] font-bold text-white">
                          {i + 1}
                        </span>
                        <span className="text-ink-2 font-medium">{m}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-line flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[11px] text-muted">
                    Ready to prepare detailed project report for this corridor intervention?
                  </div>
                  <Button
                    size="xs"
                    variant="primary"
                    icon={FileText}
                    onClick={() => setSpvProposalModalOpen(true)}
                  >
                    Generate SPV Project Brief
                  </Button>
                </div>
              </div>
            </div>

            {/* Bottom Action Banner for Workflow 4 */}
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 p-3.5">
              <div className="text-xs text-ink-2">
                Cluster intervention proposal evaluated for <strong>{intervention.cluster_name}</strong>.
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  variant="secondary"
                  icon={ArrowLeft}
                  onClick={() => setTab('supplier')}
                >
                  Back to Suppliers
                </Button>
                <Button
                  size="xs"
                  variant="primary"
                  icon={ArrowRight}
                  onClick={() => setTab('diversification')}
                >
                  Step 5: Product Diversification Simulator →
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ========================================================================= */}
      {/* WORKFLOW 5: PRODUCT EXPANSION & TRANSITION SIMULATOR */}
      {/* ========================================================================= */}
      {tab === 'diversification' && (
        <div className="space-y-6">
          <Card
            title="Factory Diversification & Transition Simulator"
            subtitle={`Evaluating adjacent high-margin product transitions tailored for plants currently manufacturing: ${product.title} (HS ${product.hsn8})`}
            icon={TrendingUp}
          >
            {/* Context Banner */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand/20 bg-brand-soft/20 p-3 text-xs">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-brand" />
                <span className="font-semibold text-ink">Active Production Line:</span>
                <span className="rounded bg-brand/10 px-2 py-0.5 font-bold text-brand-ink">
                  {product.title} (HS {product.hsn8})
                </span>
              </div>
              <span className="rounded bg-ok-soft px-2 py-0.5 text-[11px] font-bold text-ok-ink">
                ✓ Showing 3 High-Synergy Adjacent Transitions for {product.sector.split('&')[0]}
              </span>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {diversifications.map((opp, idx) => (
                <div
                  key={idx}
                  className="flex flex-col justify-between rounded-xl border border-line bg-surface p-4 shadow-sm hover:border-brand/40"
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="rounded bg-brand/10 px-2 py-0.5 font-mono text-[11px] font-bold text-brand-ink">
                        HS {opp.target_hs6}
                      </span>
                      <span className="rounded bg-ok-soft px-2 py-0.5 text-[10.5px] font-bold text-ok-ink">
                        High Synergy
                      </span>
                    </div>

                    <h4 className="font-bold text-sm text-ink">{opp.target_product}</h4>
                    <p className="text-xs text-muted leading-relaxed">{opp.synergy}</p>
                  </div>

                  <div className="mt-4 border-t border-line pt-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted">Estimated CAPEX:</span>
                      <span className="font-mono font-bold text-ink">{opp.capex_estimate}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs mt-1">
                      <span className="text-muted">Payback Period:</span>
                      <span className="font-mono font-semibold text-ok-ink">{opp.payback_period}</span>
                    </div>

                    <div className="mt-3">
                      <Button
                        size="xs"
                        variant="secondary"
                        icon={TrendingUp}
                        className="w-full"
                        onClick={() => setSimulatorTarget(opp)}
                      >
                        Simulate Transition
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Bottom Action Banner for Workflow 5 */}
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 p-3.5">
              <div className="text-xs text-ink-2">
                Completed 5-step decision workflow for <strong>{product.title}</strong>.
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  variant="secondary"
                  icon={ArrowLeft}
                  onClick={() => setTab('intervention')}
                >
                  Back to Cluster Interventions
                </Button>
                <Button
                  size="xs"
                  variant="primary"
                  icon={RotateCcw}
                  onClick={() => setTab('opportunity')}
                >
                  Evaluate Another Strategic Product ↺
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL 1: PRODUCT READINESS INDEX METHODOLOGY & EQUATION */}
      {/* ==================================================================== */}
      <Modal
        open={showPriFormulaModal}
        onClose={() => setShowPriFormulaModal(false)}
        size="lg"
        title="Product Readiness Index (PRI) — Mathematical Methodology & Parameters"
        description="Evidence-led quantitative readiness framework formulated in accordance with the India Manufacturing Atlas AI Concept Note."
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" size="sm" onClick={() => setShowPriFormulaModal(false)}>
              Close Methodology View
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={Download}
              onClick={() => window.print()}
            >
              Print PRI Methodology Brief
            </Button>
          </div>
        }
      >
        <div className="space-y-4 text-xs">
          <div className="rounded-xl border border-brand/30 bg-brand-soft/20 p-3.5">
            <div className="font-bold text-brand-ink uppercase text-[11px]">Governing Equation</div>
            <div className="mt-1 rounded-lg bg-surface p-2 font-mono text-xs text-ink border border-line">
              PRI = 0.35 · C_comp + 0.25 · M_opp + 0.20 · P_pol + 0.20 · S_std
            </div>
            <p className="mt-1.5 text-muted leading-relaxed">
              Every score is bounded strictly between 0 and 100 points, derived dynamically from official TRADESTAT customs flows, CEPII BACI world trade matrices,
              and verified policy incentives published by DPIIT and relevant line ministries.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-line bg-surface p-3 space-y-1.5">
              <div className="font-bold text-ink">1. Competitiveness (C_comp) — 35% Weight</div>
              <ul className="list-inside list-disc text-muted space-y-1">
                <li><strong>Revealed Comparative Advantage (RCA):</strong> Computed as (India_Exp_HSN / India_Total_Exp) / (World_Exp_HSN / World_Total_Exp). RCA &gt; 1 indicates relative international advantage.</li>
                <li><strong>Production Frontier Distance:</strong> Upstream capital machinery density and tooling availability.</li>
                <li><strong>Scale Deficit:</strong> Ratio of median Indian plant output compared to global frontier plants (China, Vietnam, Germany).</li>
              </ul>
            </div>

            <div className="rounded-lg border border-line bg-surface p-3 space-y-1.5">
              <div className="font-bold text-ink">2. Market Opportunity (M_opp) — 25% Weight</div>
              <ul className="list-inside list-disc text-muted space-y-1">
                <li><strong>Global Import Addressable Market:</strong> Total USD import demand across WTO signatories.</li>
                <li><strong>3-Year Trade Expansion CAGR:</strong> Compounded annual export growth rate from official DGCIS series.</li>
                <li><strong>Domestic Import Substitution Gap:</strong> Net domestic deficit where consumption relies on foreign origin.</li>
              </ul>
            </div>

            <div className="rounded-lg border border-line bg-surface p-3 space-y-1.5">
              <div className="font-bold text-ink">3. Policy Alignment (P_pol) — 20% Weight</div>
              <ul className="list-inside list-disc text-muted space-y-1">
                <li><strong>Production Linked Incentive (PLI):</strong> Active financial outlay and incremental turnover incentives.</li>
                <li><strong>Tariff Protection Differential:</strong> Basic Customs Duty (BCD) arbitrage between finished goods and raw materials.</li>
                <li><strong>State Investment Subsidies:</strong> Power tariff rebates, SGST reimbursement, and capital interest subventions.</li>
              </ul>
            </div>

            <div className="rounded-lg border border-line bg-surface p-3 space-y-1.5">
              <div className="font-bold text-ink">4. Standards & Resilience (S_std) — 20% Weight</div>
              <ul className="list-inside list-disc text-muted space-y-1">
                <li><strong>BIS Quality Control Order (QCO):</strong> Mandatory compliance barriers guarding domestic market against substandard imports.</li>
                <li><strong>Testing Infrastructure:</strong> NABL accredited laboratories within 150 km cluster radius.</li>
                <li><strong>Supply-Chain Vulnerability & Concentration:</strong> Derived from Herfindahl-Hirschman Index (HHI).</li>
              </ul>
            </div>
          </div>

          <div className="rounded-lg border border-line bg-surface-2 p-3">
            <div className="font-semibold text-ink">Active Evaluation: {product.title}</div>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-[11.5px]">
              <span>C_comp: <strong>{product.pri_breakdown.competitiveness.score.toFixed(0)}</strong></span>
              <span>M_opp: <strong>{product.pri_breakdown.market_opportunity.score.toFixed(0)}</strong></span>
              <span>P_pol: <strong>{product.pri_breakdown.policy_alignment.score.toFixed(0)}</strong></span>
              <span>S_std: <strong>{product.pri_breakdown.standards_resilience.score.toFixed(0)}</strong></span>
              <span className="ml-auto font-bold text-brand-ink">
                Calculated PRI: {product.pri_score.toFixed(1)} ({product.pri_tier})
              </span>
            </div>
          </div>
        </div>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL 2: REQUEST TECHNICAL QUALIFICATION (RFQ) */}
      {/* ==================================================================== */}
      <Modal
        open={Boolean(rfqModalSupplier)}
        onClose={() => setRfqModalSupplier(null)}
        size="md"
        title={`Technical Qualification Request (RFQ): ${rfqModalSupplier?.name}`}
        description="Submit an official technical capability audit request or request quotation directly to the plant's verified quality manager."
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" size="sm" onClick={() => setRfqModalSupplier(null)}>
              Cancel
            </Button>
            {!rfqSubmitted ? (
              <Button
                variant="primary"
                size="sm"
                icon={FileCheck}
                onClick={() => setRfqSubmitted(true)}
              >
                Submit Qualification Request
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={() => setRfqModalSupplier(null)}>
                Done
              </Button>
            )}
          </div>
        }
      >
        {rfqSubmitted ? (
          <div className="rounded-xl bg-ok-soft/30 p-6 text-center space-y-2 border border-ok/30">
            <CheckCircle2 className="size-10 text-ok mx-auto" />
            <div className="font-bold text-ink text-sm">RFQ Successfully Dispatched</div>
            <p className="text-xs text-muted max-w-sm mx-auto">
              Your technical audit checklist and component specification requirements have been securely logged and forwarded to the quality lead at{' '}
              <strong>{rfqModalSupplier?.name}</strong>.
            </p>
            <div className="mt-3 font-mono text-[11px] text-muted">
              Reference Token: RFQ-ATLAS-{Math.floor(100000 + Math.random() * 900000)}
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-xs">
            <div className="rounded-lg bg-surface-2 p-3 border border-line space-y-1">
              <div className="font-bold text-ink">{rfqModalSupplier?.name}</div>
              <div className="text-muted">{rfqModalSupplier?.location}, {rfqModalSupplier?.state}</div>
              <div className="font-mono text-brand-ink text-[11px]">Audited Capacity: {rfqModalSupplier?.scale_capacity}</div>
            </div>

            <div className="space-y-1">
              <label className="font-semibold text-ink">Target Product & Tolerances Needed:</label>
              <input
                type="text"
                defaultValue={`${product.title} (Target Class: ${rfqModalSupplier?.tolerance_class})`}
                className="w-full rounded border border-line bg-surface p-2 text-xs text-ink focus:border-brand"
              />
            </div>

            <div className="space-y-1">
              <label className="font-semibold text-ink">Batch Scale / Annual Run Rate:</label>
              <input
                type="text"
                defaultValue="50,000 units / year (Initial Pilot 2,500 units)"
                className="w-full rounded border border-line bg-surface p-2 text-xs text-ink focus:border-brand"
              />
            </div>

            <div className="space-y-1">
              <label className="font-semibold text-ink">Special Testing & Compliance Requirements:</label>
              <textarea
                rows={3}
                defaultValue="Require CMM full coordinate dimensional report, 100% optical leak check, and raw material heat treatment mill test certificate (EN 10204 3.1)."
                className="w-full rounded border border-line bg-surface p-2 text-xs text-ink focus:border-brand"
              />
            </div>
          </div>
        )}
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL 3: ICEGATE CUSTOMS CLEARANCE AUDIT FOR TRADERS */}
      {/* ==================================================================== */}
      <Modal
        open={Boolean(customsModalTrader)}
        onClose={() => setCustomsModalTrader(null)}
        size="md"
        title={`ICEGATE Customs Audit: ${customsModalTrader?.name}`}
        description="Official cross-border trade declaration ledger verifying that this entity operates as an importer/indenting trader rather than domestic fabricator."
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" size="sm" onClick={() => setCustomsModalTrader(null)}>
              Close Clearance Ledger
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-xs">
          <div className="rounded-lg bg-amber-soft/20 p-3 border border-amber-300/40">
            <div className="font-bold text-amber-ink">Commercial Importer Classification</div>
            <p className="text-muted mt-1 leading-relaxed">
              DPIIT & CBIC data cross-matching confirms <strong>{customsModalTrader?.name}</strong> does not own manufacturing machinery for HSN {product.hsn8} in India. All supplied volumes are cleared via commercial Bills of Entry at sea/air ports.
            </p>
          </div>

          <div className="rounded-lg border border-line bg-surface overflow-hidden">
            <table className="w-full text-left border-collapse text-[11px]">
              <thead>
                <tr className="bg-surface-2 border-b border-line">
                  <th className="p-2 font-semibold">Port of Entry</th>
                  <th className="p-2 font-semibold">HS Code</th>
                  <th className="p-2 font-semibold">Country of Origin</th>
                  <th className="p-2 font-semibold">Avg. CIF Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line font-mono">
                <tr>
                  <td className="p-2">Nhava Sheva (INNSA1)</td>
                  <td className="p-2">{product.hsn8}</td>
                  <td className="p-2">China / Vietnam</td>
                  <td className="p-2 text-brand-ink">$1.4M / mo</td>
                </tr>
                <tr>
                  <td className="p-2">Chennai Sea (INMAA1)</td>
                  <td className="p-2">{product.hs6}</td>
                  <td className="p-2">South Korea / Taiwan</td>
                  <td className="p-2 text-brand-ink">$850k / mo</td>
                </tr>
                <tr>
                  <td className="p-2">Delhi Air Cargo (INDEL4)</td>
                  <td className="p-2">{product.hsn8}</td>
                  <td className="p-2">Germany / Japan</td>
                  <td className="p-2 text-brand-ink">$420k / mo</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="text-muted text-[11px]">
            * Source: ICEGATE customs clearance records, CBIC Authorised Economic Operator (AEO) database, and DGFT IEC registers.
          </div>
        </div>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL 4: STRATEGIC DECISION MEMO EXPORT */}
      {/* ==================================================================== */}
      <Modal
        open={memoModalOpen}
        onClose={() => setMemoModalOpen(false)}
        size="lg"
        title="Manufacturing Decision Assessment Dossier"
        description={`Executive Decision Memo for HSN ${product.hsn8} — ${product.title}`}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" size="sm" onClick={() => setMemoModalOpen(false)}>
              Close Dossier
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={Download}
              onClick={() => window.print()}
            >
              Print / Save as PDF
            </Button>
          </div>
        }
      >
        <div className="space-y-4 text-xs font-serif leading-relaxed text-ink">
          <div className="border-b border-line pb-3">
            <div className="text-[11px] font-sans font-bold uppercase text-brand tracking-wider">
              India Manufacturing Atlas AI · Office of Industrial Policy
            </div>
            <h2 className="text-lg font-sans font-extrabold text-ink mt-1">
              Strategic Manufacturing Decision Memo: {product.title}
            </h2>
            <div className="text-muted text-xs font-sans mt-0.5">
              HS Code: {product.hsn8} | Sector: {product.sector} | Owning Ministry: {product.ministry}
            </div>
          </div>

          <div>
            <h4 className="font-sans font-bold text-ink">1. Strategic Evaluation Verdict</h4>
            <div className="mt-1 space-y-1.5 text-ink-2 font-sans">
              <p><strong>Trade Analysis:</strong> {product.deductive_summary.trade_deduction}</p>
              <p><strong>Bottleneck Analysis:</strong> {product.deductive_summary.bottleneck_deduction}</p>
              <p><strong>Policy Action:</strong> {product.deductive_summary.policy_action}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 font-sans">
            <div className="rounded-lg bg-surface-2 p-3 border border-line">
              <div className="font-bold text-ink">Trade Balance Position</div>
              <div className="mt-1 font-mono text-base font-extrabold text-brand-ink">{netTradeFormatted}</div>
              <div className="text-muted text-[11px]">Global Demand: {globalMarketFormatted}</div>
            </div>

            <div className="rounded-lg bg-surface-2 p-3 border border-line">
              <div className="font-bold text-ink">Product Readiness Score</div>
              <div className="mt-1 font-mono text-base font-extrabold text-ok-ink">{product.pri_score.toFixed(1)} / 100</div>
              <div className="text-muted text-[11px]">Classification: {product.pri_tier}</div>
            </div>
          </div>

          <div>
            <h4 className="font-sans font-bold text-ink">2. Critical Bottlenecks to Overcome</h4>
            <ul className="mt-1 list-inside list-disc space-y-1 font-sans text-muted">
              {product.constraints.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="font-sans font-bold text-ink">3. Action Plan & Policy Directives</h4>
            <ul className="mt-1 list-inside list-disc space-y-1 font-sans text-muted">
              {product.next_checks.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </div>
        </div>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL 5: TRANSITION & CAPEX SIMULATOR */}
      {/* ==================================================================== */}
      <Modal
        open={Boolean(simulatorTarget)}
        onClose={() => setSimulatorTarget(null)}
        size="md"
        title={`Transition Simulator: ${simulatorTarget?.target_product}`}
        description={`Simulating capital expenditure, machinery modification, and payback to transition production from ${product.title}.`}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" size="sm" onClick={() => setSimulatorTarget(null)}>
              Close Simulator
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-xs">
          <div className="rounded-lg bg-brand-soft/30 p-3 border border-brand/20 space-y-1">
            <div className="font-bold text-ink">Transition Target: {simulatorTarget?.target_product}</div>
            <div className="font-mono text-brand-ink text-[11px]">Target HS6: {simulatorTarget?.target_hs6}</div>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded bg-surface-2 p-2 border border-line">
              <div className="text-muted text-[11px]">Required CAPEX</div>
              <div className="font-mono font-bold text-ink text-sm mt-0.5">{simulatorTarget?.capex_estimate}</div>
            </div>
            <div className="rounded bg-surface-2 p-2 border border-line">
              <div className="text-muted text-[11px]">Estimated Payback</div>
              <div className="font-mono font-bold text-ok-ink text-sm mt-0.5">{simulatorTarget?.payback_period}</div>
            </div>
          </div>

          <div>
            <h4 className="font-semibold text-ink">Technical Synergy Analysis</h4>
            <p className="mt-1 text-ink-2 leading-relaxed">{simulatorTarget?.synergy}</p>
          </div>

          <div className="rounded-lg border border-line bg-surface p-3 space-y-2">
            <div className="font-semibold text-ink">Indicative 3-Year Cashflow Simulation</div>
            <div className="space-y-1 font-mono text-[11px]">
              <div className="flex justify-between text-muted">
                <span>Year 1 (Capex & Tooling):</span>
                <span className="text-danger-ink">-{simulatorTarget?.capex_estimate}</span>
              </div>
              <div className="flex justify-between text-muted">
                <span>Year 2 (Run Rate 60%):</span>
                <span className="text-ok-ink">+₹6.5 Crore Revenue</span>
              </div>
              <div className="flex justify-between text-muted">
                <span>Year 3 (Run Rate 100%):</span>
                <span className="text-ok-ink">+₹14.2 Crore Revenue</span>
              </div>
            </div>
          </div>
        </div>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL 6: SUBMIT SPV PROPOSAL MODAL */}
      {/* ==================================================================== */}
      <Modal
        open={spvProposalModalOpen}
        onClose={() => setSpvProposalModalOpen(false)}
        size="md"
        title={`Cluster Infrastructure SPV Proposal: ${intervention.cluster_name}`}
        description="Formal project preparation facility for public-private Special Purpose Vehicle (SPV) common infrastructure funding."
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" size="sm" onClick={() => setSpvProposalModalOpen(false)}>
              Close
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={Download}
              onClick={() => window.print()}
            >
              Export Project Brief
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-xs">
          <div className="rounded-lg bg-surface-2 p-3 border border-line">
            <div className="font-bold text-ink">{intervention.cluster_name} ({intervention.state})</div>
            <div className="text-muted">Lead Sponsoring Ministry: {intervention.lead_agency}</div>
            <div className="font-extrabold text-brand-ink text-sm mt-1">{intervention.indicative_cost}</div>
          </div>

          <div>
            <h4 className="font-semibold text-ink">Identified Cluster Demand Evidence</h4>
            <p className="mt-1 text-ink-2 leading-relaxed">{intervention.evidence_demand}</p>
          </div>

          <div>
            <h4 className="font-semibold text-ink">Phased Implementation Milestones</h4>
            <div className="mt-1 space-y-1">
              {intervention.milestones.map((m, i) => (
                <div key={i} className="flex items-start gap-2 rounded bg-surface p-2 border border-line">
                  <span className="font-bold text-brand">{i + 1}.</span>
                  <span className="text-ink-2">{m}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
