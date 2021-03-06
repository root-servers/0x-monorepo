import { getContractAddressesForChainOrThrow } from '@0x/contract-addresses';
import {
    assertRoughlyEquals,
    constants,
    expect,
    getRandomFloat,
    getRandomInteger,
    Numberish,
    randomAddress,
} from '@0x/contracts-test-utils';
import { Web3Wrapper } from '@0x/dev-utils';
import { assetDataUtils, generatePseudoRandomSalt } from '@0x/order-utils';
import { AssetProxyId, ERC20BridgeAssetData, SignedOrder } from '@0x/types';
import { BigNumber, fromTokenUnitAmount, hexUtils, NULL_ADDRESS } from '@0x/utils';
import * as _ from 'lodash';
import * as TypeMoq from 'typemoq';

import { MarketOperation, QuoteRequestor, RfqtRequestOpts, SignedOrderWithFillableAmounts } from '../src';
import { getRfqtIndicativeQuotesAsync, MarketOperationUtils } from '../src/utils/market_operation_utils/';
import { BalancerPoolsCache } from '../src/utils/market_operation_utils/balancer_utils';
import {
    BUY_SOURCE_FILTER,
    POSITIVE_INF,
    SELL_SOURCE_FILTER,
    SOURCE_FLAGS,
    ZERO_AMOUNT,
} from '../src/utils/market_operation_utils/constants';
import { createFills } from '../src/utils/market_operation_utils/fills';
import { DexOrderSampler } from '../src/utils/market_operation_utils/sampler';
import { BATCH_SOURCE_FILTERS } from '../src/utils/market_operation_utils/sampler_operations';
import {
    DexSample,
    ERC20BridgeSource,
    FillData,
    NativeFillData,
    OptimizedMarketOrder,
} from '../src/utils/market_operation_utils/types';

const MAKER_TOKEN = randomAddress();
const TAKER_TOKEN = randomAddress();
const MAKER_ASSET_DATA = assetDataUtils.encodeERC20AssetData(MAKER_TOKEN);
const TAKER_ASSET_DATA = assetDataUtils.encodeERC20AssetData(TAKER_TOKEN);
const DEFAULT_EXCLUDED = [
    ERC20BridgeSource.UniswapV2,
    ERC20BridgeSource.Curve,
    ERC20BridgeSource.Balancer,
    ERC20BridgeSource.MStable,
    ERC20BridgeSource.Mooniswap,
    ERC20BridgeSource.Bancor,
    ERC20BridgeSource.Swerve,
    ERC20BridgeSource.SushiSwap,
    ERC20BridgeSource.MultiHop,
    ERC20BridgeSource.Shell,
];
const BUY_SOURCES = BUY_SOURCE_FILTER.sources;
const SELL_SOURCES = SELL_SOURCE_FILTER.sources;

// tslint:disable: custom-no-magic-numbers promise-function-async
describe('MarketOperationUtils tests', () => {
    const CHAIN_ID = 1;
    const contractAddresses = { ...getContractAddressesForChainOrThrow(CHAIN_ID), multiBridge: NULL_ADDRESS };

    function createOrder(overrides?: Partial<SignedOrder>): SignedOrder {
        return {
            chainId: CHAIN_ID,
            exchangeAddress: contractAddresses.exchange,
            makerAddress: constants.NULL_ADDRESS,
            takerAddress: constants.NULL_ADDRESS,
            senderAddress: constants.NULL_ADDRESS,
            feeRecipientAddress: randomAddress(),
            salt: generatePseudoRandomSalt(),
            expirationTimeSeconds: getRandomInteger(0, 2 ** 64),
            makerAssetData: MAKER_ASSET_DATA,
            takerAssetData: TAKER_ASSET_DATA,
            makerFeeAssetData: constants.NULL_BYTES,
            takerFeeAssetData: constants.NULL_BYTES,
            makerAssetAmount: getRandomInteger(1, 1e18),
            takerAssetAmount: getRandomInteger(1, 1e18),
            makerFee: constants.ZERO_AMOUNT,
            takerFee: constants.ZERO_AMOUNT,
            signature: hexUtils.random(),
            ...overrides,
        };
    }

    function getSourceFromAssetData(assetData: string): ERC20BridgeSource {
        if (assetData.length === 74) {
            return ERC20BridgeSource.Native;
        }
        const bridgeData = assetDataUtils.decodeAssetDataOrThrow(assetData);
        if (!assetDataUtils.isERC20BridgeAssetData(bridgeData)) {
            throw new Error('AssetData is not ERC20BridgeAssetData');
        }
        const { bridgeAddress } = bridgeData;
        switch (bridgeAddress) {
            case contractAddresses.kyberBridge.toLowerCase():
                return ERC20BridgeSource.Kyber;
            case contractAddresses.eth2DaiBridge.toLowerCase():
                return ERC20BridgeSource.Eth2Dai;
            case contractAddresses.uniswapBridge.toLowerCase():
                return ERC20BridgeSource.Uniswap;
            case contractAddresses.uniswapV2Bridge.toLowerCase():
                return ERC20BridgeSource.UniswapV2;
            case contractAddresses.curveBridge.toLowerCase():
                return ERC20BridgeSource.Curve;
            case contractAddresses.mStableBridge.toLowerCase():
                return ERC20BridgeSource.MStable;
            case contractAddresses.mooniswapBridge.toLowerCase():
                return ERC20BridgeSource.Mooniswap;
            case contractAddresses.sushiswapBridge.toLowerCase():
                return ERC20BridgeSource.SushiSwap;
            case contractAddresses.shellBridge.toLowerCase():
                return ERC20BridgeSource.Shell;
            default:
                break;
        }
        throw new Error(`Unknown bridge address: ${bridgeAddress}`);
    }

    function assertSamePrefix(actual: string, expected: string): void {
        expect(actual.substr(0, expected.length)).to.eq(expected);
    }

    function createOrdersFromSellRates(takerAssetAmount: BigNumber, rates: Numberish[]): SignedOrder[] {
        const singleTakerAssetAmount = takerAssetAmount.div(rates.length).integerValue(BigNumber.ROUND_UP);
        return rates.map(r =>
            createOrder({
                makerAssetAmount: singleTakerAssetAmount.times(r).integerValue(),
                takerAssetAmount: singleTakerAssetAmount,
            }),
        );
    }

    function createOrdersFromBuyRates(makerAssetAmount: BigNumber, rates: Numberish[]): SignedOrder[] {
        const singleMakerAssetAmount = makerAssetAmount.div(rates.length).integerValue(BigNumber.ROUND_UP);
        return rates.map(r =>
            createOrder({
                makerAssetAmount: singleMakerAssetAmount,
                takerAssetAmount: singleMakerAssetAmount.div(r).integerValue(),
            }),
        );
    }

    const ORDER_DOMAIN = {
        exchangeAddress: contractAddresses.exchange,
        chainId: CHAIN_ID,
    };

    function createSamplesFromRates(
        source: ERC20BridgeSource,
        inputs: Numberish[],
        rates: Numberish[],
        fillData?: FillData,
    ): DexSample[] {
        const samples: DexSample[] = [];
        inputs.forEach((input, i) => {
            const rate = rates[i];
            samples.push({
                source,
                fillData: fillData || DEFAULT_FILL_DATA[source],
                input: new BigNumber(input),
                output: new BigNumber(input)
                    .minus(i === 0 ? 0 : samples[i - 1].input)
                    .times(rate)
                    .plus(i === 0 ? 0 : samples[i - 1].output)
                    .integerValue(),
            });
        });
        return samples;
    }

    type GetMultipleQuotesOperation = (
        sources: ERC20BridgeSource[],
        makerToken: string,
        takerToken: string,
        fillAmounts: BigNumber[],
        wethAddress: string,
        liquidityProviderAddress?: string,
    ) => DexSample[][];

    function createGetMultipleSellQuotesOperationFromRates(rates: RatesBySource): GetMultipleQuotesOperation {
        return (
            sources: ERC20BridgeSource[],
            _makerToken: string,
            _takerToken: string,
            fillAmounts: BigNumber[],
            _wethAddress: string,
        ) => {
            return BATCH_SOURCE_FILTERS.getAllowed(sources).map(s => createSamplesFromRates(s, fillAmounts, rates[s]));
        };
    }

    function callTradeOperationAndRetainLiquidityProviderParams(
        tradeOperation: (rates: RatesBySource) => GetMultipleQuotesOperation,
        rates: RatesBySource,
    ): [{ sources: ERC20BridgeSource[]; liquidityProviderAddress?: string }, GetMultipleQuotesOperation] {
        const liquidityPoolParams: { sources: ERC20BridgeSource[]; liquidityProviderAddress?: string } = {
            sources: [],
            liquidityProviderAddress: undefined,
        };
        const fn = (
            sources: ERC20BridgeSource[],
            makerToken: string,
            takerToken: string,
            fillAmounts: BigNumber[],
            wethAddress: string,
            liquidityProviderAddress?: string,
        ) => {
            liquidityPoolParams.liquidityProviderAddress = liquidityProviderAddress;
            liquidityPoolParams.sources = liquidityPoolParams.sources.concat(sources);
            return tradeOperation(rates)(
                sources,
                makerToken,
                takerToken,
                fillAmounts,
                wethAddress,
                liquidityProviderAddress,
            );
        };
        return [liquidityPoolParams, fn];
    }

    function createGetMultipleBuyQuotesOperationFromRates(rates: RatesBySource): GetMultipleQuotesOperation {
        return (
            sources: ERC20BridgeSource[],
            _makerToken: string,
            _takerToken: string,
            fillAmounts: BigNumber[],
            _wethAddress: string,
        ) => {
            return BATCH_SOURCE_FILTERS.getAllowed(sources).map(s =>
                createSamplesFromRates(s, fillAmounts, rates[s].map(r => new BigNumber(1).div(r))),
            );
        };
    }

    type GetMedianRateOperation = (
        sources: ERC20BridgeSource[],
        makerToken: string,
        takerToken: string,
        fillAmounts: BigNumber[],
        wethAddress: string,
        liquidityProviderAddress?: string,
    ) => BigNumber;

    function createGetMedianSellRate(rate: Numberish): GetMedianRateOperation {
        return (
            _sources: ERC20BridgeSource[],
            _makerToken: string,
            _takerToken: string,
            _fillAmounts: BigNumber[],
            _wethAddress: string,
        ) => {
            return new BigNumber(rate);
        };
    }

    function createDecreasingRates(count: number): BigNumber[] {
        const rates: BigNumber[] = [];
        const initialRate = getRandomFloat(1e-3, 1e2);
        _.times(count, () => getRandomFloat(0.95, 1)).forEach((r, i) => {
            const prevRate = i === 0 ? initialRate : rates[i - 1];
            rates.push(prevRate.times(r));
        });
        return rates;
    }

    const NUM_SAMPLES = 3;

    interface RatesBySource {
        [source: string]: Numberish[];
    }

    const ZERO_RATES: RatesBySource = {
        [ERC20BridgeSource.Native]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Eth2Dai]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Uniswap]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Kyber]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.UniswapV2]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Balancer]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Bancor]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Curve]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.LiquidityProvider]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.MultiBridge]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.MStable]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Mooniswap]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Swerve]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.SushiSwap]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.MultiHop]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Shell]: _.times(NUM_SAMPLES, () => 0),
    };

    const DEFAULT_RATES: RatesBySource = {
        ...ZERO_RATES,
        [ERC20BridgeSource.Native]: createDecreasingRates(NUM_SAMPLES),
        [ERC20BridgeSource.Eth2Dai]: createDecreasingRates(NUM_SAMPLES),
        [ERC20BridgeSource.Uniswap]: createDecreasingRates(NUM_SAMPLES),
    };

    interface FillDataBySource {
        [source: string]: FillData;
    }

    const DEFAULT_FILL_DATA: FillDataBySource = {
        [ERC20BridgeSource.UniswapV2]: { tokenAddressPath: [] },
        [ERC20BridgeSource.Balancer]: { poolAddress: randomAddress() },
        [ERC20BridgeSource.Bancor]: { path: [], networkAddress: randomAddress() },
        [ERC20BridgeSource.Kyber]: { hint: '0x', reserveId: '0x' },
        [ERC20BridgeSource.Curve]: {
            curve: {
                poolAddress: randomAddress(),
                tokens: [TAKER_TOKEN, MAKER_TOKEN],
                exchangeFunctionSelector: hexUtils.random(4),
                sellQuoteFunctionSelector: hexUtils.random(4),
                buyQuoteFunctionSelector: hexUtils.random(4),
            },
            fromTokenIdx: 0,
            toTokenIdx: 1,
        },
        [ERC20BridgeSource.Swerve]: {
            pool: {
                poolAddress: randomAddress(),
                tokens: [TAKER_TOKEN, MAKER_TOKEN],
                exchangeFunctionSelector: hexUtils.random(4),
                sellQuoteFunctionSelector: hexUtils.random(4),
                buyQuoteFunctionSelector: hexUtils.random(4),
            },
            fromTokenIdx: 0,
            toTokenIdx: 1,
        },
        [ERC20BridgeSource.LiquidityProvider]: { poolAddress: randomAddress() },
        [ERC20BridgeSource.SushiSwap]: { tokenAddressPath: [] },
        [ERC20BridgeSource.Mooniswap]: { poolAddress: randomAddress() },
        [ERC20BridgeSource.Native]: { order: createOrder() },
        [ERC20BridgeSource.MultiHop]: {},
        [ERC20BridgeSource.Shell]: {},
    };

    const DEFAULT_OPS = {
        getOrderFillableTakerAmounts(orders: SignedOrder[]): BigNumber[] {
            return orders.map(o => o.takerAssetAmount);
        },
        getOrderFillableMakerAmounts(orders: SignedOrder[]): BigNumber[] {
            return orders.map(o => o.makerAssetAmount);
        },
        getSellQuotes: createGetMultipleSellQuotesOperationFromRates(DEFAULT_RATES),
        getBuyQuotes: createGetMultipleBuyQuotesOperationFromRates(DEFAULT_RATES),
        getMedianSellRate: createGetMedianSellRate(1),
        getBalancerSellQuotesOffChainAsync: (
            _makerToken: string,
            _takerToken: string,
            takerFillAmounts: BigNumber[],
        ) => [
            createSamplesFromRates(
                ERC20BridgeSource.Balancer,
                takerFillAmounts,
                createDecreasingRates(takerFillAmounts.length),
                DEFAULT_FILL_DATA[ERC20BridgeSource.Balancer],
            ),
        ],
        getBalancerBuyQuotesOffChainAsync: (
            _makerToken: string,
            _takerToken: string,
            makerFillAmounts: BigNumber[],
        ) => [
            createSamplesFromRates(
                ERC20BridgeSource.Balancer,
                makerFillAmounts,
                createDecreasingRates(makerFillAmounts.length).map(r => new BigNumber(1).div(r)),
                DEFAULT_FILL_DATA[ERC20BridgeSource.Balancer],
            ),
        ],
        getBancorSellQuotesOffChainAsync: (_makerToken: string, _takerToken: string, takerFillAmounts: BigNumber[]) =>
            createSamplesFromRates(
                ERC20BridgeSource.Bancor,
                takerFillAmounts,
                createDecreasingRates(takerFillAmounts.length),
                DEFAULT_FILL_DATA[ERC20BridgeSource.Bancor],
            ),
        getTwoHopSellQuotes: (..._params: any[]) => [],
        getTwoHopBuyQuotes: (..._params: any[]) => [],
    };

    const MOCK_SAMPLER = ({
        async executeAsync(...ops: any[]): Promise<any[]> {
            return MOCK_SAMPLER.executeBatchAsync(ops);
        },
        async executeBatchAsync(ops: any[]): Promise<any[]> {
            return ops;
        },
        balancerPoolsCache: new BalancerPoolsCache(),
    } as any) as DexOrderSampler;

    function replaceSamplerOps(ops: Partial<typeof DEFAULT_OPS> = {}): void {
        Object.assign(MOCK_SAMPLER, DEFAULT_OPS);
        Object.assign(MOCK_SAMPLER, ops);
    }

    describe('getRfqtIndicativeQuotesAsync', () => {
        const partialRfqt: RfqtRequestOpts = {
            apiKey: 'foo',
            takerAddress: NULL_ADDRESS,
            isIndicative: true,
            intentOnFilling: false,
        };

        it('calls RFQT', async () => {
            const requestor = TypeMoq.Mock.ofType(QuoteRequestor, TypeMoq.MockBehavior.Loose);
            requestor
                .setup(r =>
                    r.requestRfqtIndicativeQuotesAsync(
                        TypeMoq.It.isAny(),
                        TypeMoq.It.isAny(),
                        TypeMoq.It.isAny(),
                        TypeMoq.It.isAny(),
                        TypeMoq.It.isAny(),
                    ),
                )
                .returns(() => Promise.resolve([]))
                .verifiable(TypeMoq.Times.once());
            await getRfqtIndicativeQuotesAsync(
                MAKER_ASSET_DATA,
                TAKER_ASSET_DATA,
                MarketOperation.Sell,
                new BigNumber('100e18'),
                {
                    rfqt: { quoteRequestor: requestor.object, ...partialRfqt },
                },
            );
            requestor.verifyAll();
        });
    });

    describe('MarketOperationUtils', () => {
        let marketOperationUtils: MarketOperationUtils;

        before(async () => {
            marketOperationUtils = new MarketOperationUtils(MOCK_SAMPLER, contractAddresses, ORDER_DOMAIN);
        });

        describe('getMarketSellOrdersAsync()', () => {
            const FILL_AMOUNT = new BigNumber('100e18');
            const ORDERS = createOrdersFromSellRates(
                FILL_AMOUNT,
                _.times(NUM_SAMPLES, i => DEFAULT_RATES[ERC20BridgeSource.Native][i]),
            );
            const DEFAULT_OPTS = {
                numSamples: NUM_SAMPLES,
                sampleDistributionBase: 1,
                bridgeSlippage: 0,
                maxFallbackSlippage: 100,
                excludedSources: DEFAULT_EXCLUDED,
                allowFallback: false,
            };

            beforeEach(() => {
                replaceSamplerOps();
            });

            it('queries `numSamples` samples', async () => {
                const numSamples = _.random(1, NUM_SAMPLES);
                let actualNumSamples = 0;
                replaceSamplerOps({
                    getSellQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        actualNumSamples = amounts.length;
                        return DEFAULT_OPS.getSellQuotes(sources, makerToken, takerToken, amounts, wethAddress);
                    },
                });
                await marketOperationUtils.getMarketSellOrdersAsync(ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    numSamples,
                });
                expect(actualNumSamples).eq(numSamples);
            });

            it('polls all DEXes if `excludedSources` is empty', async () => {
                let sourcesPolled: ERC20BridgeSource[] = [];
                replaceSamplerOps({
                    getSellQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        sourcesPolled = sourcesPolled.concat(sources.slice());
                        return DEFAULT_OPS.getSellQuotes(sources, makerToken, takerToken, amounts, wethAddress);
                    },
                    getTwoHopSellQuotes: (...args: any[]) => {
                        sourcesPolled.push(ERC20BridgeSource.MultiHop);
                        return DEFAULT_OPS.getTwoHopSellQuotes(...args);
                    },
                    getBalancerSellQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        takerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Balancer);
                        return DEFAULT_OPS.getBalancerSellQuotesOffChainAsync(makerToken, takerToken, takerFillAmounts);
                    },
                });
                await marketOperationUtils.getMarketSellOrdersAsync(ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    excludedSources: [],
                });
                expect(_.uniq(sourcesPolled).sort()).to.deep.equals(SELL_SOURCES.slice().sort());
            });

            it('polls the liquidity provider when the registry is provided in the arguments', async () => {
                const [args, fn] = callTradeOperationAndRetainLiquidityProviderParams(
                    createGetMultipleSellQuotesOperationFromRates,
                    DEFAULT_RATES,
                );
                replaceSamplerOps({
                    getSellQuotes: fn,
                    getTwoHopSellQuotes: (sources: ERC20BridgeSource[], ..._args: any[]) => {
                        if (sources.length !== 0) {
                            args.sources.push(ERC20BridgeSource.MultiHop);
                            args.sources.push(...sources);
                        }
                        return DEFAULT_OPS.getTwoHopSellQuotes(..._args);
                    },
                    getBalancerSellQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        takerFillAmounts: BigNumber[],
                    ) => {
                        args.sources = args.sources.concat(ERC20BridgeSource.Balancer);
                        return DEFAULT_OPS.getBalancerSellQuotesOffChainAsync(makerToken, takerToken, takerFillAmounts);
                    },
                });
                const registryAddress = randomAddress();
                const newMarketOperationUtils = new MarketOperationUtils(
                    MOCK_SAMPLER,
                    contractAddresses,
                    ORDER_DOMAIN,
                    registryAddress,
                );
                await newMarketOperationUtils.getMarketSellOrdersAsync(ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    excludedSources: [],
                });
                expect(_.uniq(args.sources).sort()).to.deep.equals(
                    SELL_SOURCES.concat([ERC20BridgeSource.LiquidityProvider]).sort(),
                );
                expect(args.liquidityProviderAddress).to.eql(registryAddress);
            });

            it('does not poll DEXes in `excludedSources`', async () => {
                const excludedSources = [ERC20BridgeSource.Uniswap, ERC20BridgeSource.Eth2Dai];
                let sourcesPolled: ERC20BridgeSource[] = [];
                replaceSamplerOps({
                    getSellQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        sourcesPolled = sourcesPolled.concat(sources.slice());
                        return DEFAULT_OPS.getSellQuotes(sources, makerToken, takerToken, amounts, wethAddress);
                    },
                    getTwoHopSellQuotes: (sources: ERC20BridgeSource[], ...args: any[]) => {
                        if (sources.length !== 0) {
                            sourcesPolled.push(ERC20BridgeSource.MultiHop);
                            sourcesPolled.push(...sources);
                        }
                        return DEFAULT_OPS.getTwoHopSellQuotes(...args);
                    },
                    getBalancerSellQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        takerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Balancer);
                        return DEFAULT_OPS.getBalancerSellQuotesOffChainAsync(makerToken, takerToken, takerFillAmounts);
                    },
                });
                await marketOperationUtils.getMarketSellOrdersAsync(ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    excludedSources,
                });
                expect(_.uniq(sourcesPolled).sort()).to.deep.equals(_.without(SELL_SOURCES, ...excludedSources).sort());
            });

            it('only polls DEXes in `includedSources`', async () => {
                const includedSources = [ERC20BridgeSource.Uniswap, ERC20BridgeSource.Eth2Dai];
                let sourcesPolled: ERC20BridgeSource[] = [];
                replaceSamplerOps({
                    getSellQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        sourcesPolled = sourcesPolled.concat(sources.slice());
                        return DEFAULT_OPS.getSellQuotes(sources, makerToken, takerToken, amounts, wethAddress);
                    },
                    getTwoHopSellQuotes: (sources: ERC20BridgeSource[], ...args: any[]) => {
                        if (sources.length !== 0) {
                            sourcesPolled.push(ERC20BridgeSource.MultiHop);
                            sourcesPolled.push(...sources);
                        }
                        return DEFAULT_OPS.getTwoHopSellQuotes(sources, ...args);
                    },
                    getBalancerSellQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        takerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Balancer);
                        return DEFAULT_OPS.getBalancerSellQuotesOffChainAsync(makerToken, takerToken, takerFillAmounts);
                    },
                });
                await marketOperationUtils.getMarketSellOrdersAsync(ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    excludedSources: [],
                    includedSources,
                });
                expect(_.uniq(sourcesPolled).sort()).to.deep.equals(includedSources.sort());
            });

            it('generates bridge orders with correct asset data', async () => {
                const improvedOrdersResponse = await marketOperationUtils.getMarketSellOrdersAsync(
                    // Pass in empty orders to prevent native orders from being used.
                    ORDERS.map(o => ({ ...o, makerAssetAmount: constants.ZERO_AMOUNT })),
                    FILL_AMOUNT,
                    DEFAULT_OPTS,
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                expect(improvedOrders).to.not.be.length(0);
                for (const order of improvedOrders) {
                    expect(getSourceFromAssetData(order.makerAssetData)).to.exist('');
                    const makerAssetDataPrefix = hexUtils.slice(
                        assetDataUtils.encodeERC20BridgeAssetData(
                            MAKER_TOKEN,
                            constants.NULL_ADDRESS,
                            constants.NULL_BYTES,
                        ),
                        0,
                        36,
                    );
                    assertSamePrefix(order.makerAssetData, makerAssetDataPrefix);
                    expect(order.takerAssetData).to.eq(TAKER_ASSET_DATA);
                }
            });

            it('generates bridge orders with correct taker amount', async () => {
                const improvedOrdersResponse = await marketOperationUtils.getMarketSellOrdersAsync(
                    // Pass in empty orders to prevent native orders from being used.
                    ORDERS.map(o => ({ ...o, makerAssetAmount: constants.ZERO_AMOUNT })),
                    FILL_AMOUNT,
                    DEFAULT_OPTS,
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const totalTakerAssetAmount = BigNumber.sum(...improvedOrders.map(o => o.takerAssetAmount));
                expect(totalTakerAssetAmount).to.bignumber.gte(FILL_AMOUNT);
            });

            it('generates bridge orders with max slippage of `bridgeSlippage`', async () => {
                const bridgeSlippage = _.random(0.1, true);
                const improvedOrdersResponse = await marketOperationUtils.getMarketSellOrdersAsync(
                    // Pass in empty orders to prevent native orders from being used.
                    ORDERS.map(o => ({ ...o, makerAssetAmount: constants.ZERO_AMOUNT })),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, bridgeSlippage },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                expect(improvedOrders).to.not.be.length(0);
                for (const order of improvedOrders) {
                    const expectedMakerAmount = order.fills[0].output;
                    const slippage = new BigNumber(1).minus(order.makerAssetAmount.div(expectedMakerAmount.plus(1)));
                    assertRoughlyEquals(slippage, bridgeSlippage, 1);
                }
            });

            it('can mix convex sources', async () => {
                const rates: RatesBySource = { ...DEFAULT_RATES };
                rates[ERC20BridgeSource.Native] = [0.4, 0.3, 0.2, 0.1];
                rates[ERC20BridgeSource.Uniswap] = [0.5, 0.05, 0.05, 0.05];
                rates[ERC20BridgeSource.Eth2Dai] = [0.6, 0.05, 0.05, 0.05];
                rates[ERC20BridgeSource.Kyber] = [0, 0, 0, 0]; // unused
                replaceSamplerOps({
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketSellOrdersAsync(
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4 },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [
                    ERC20BridgeSource.Eth2Dai,
                    ERC20BridgeSource.Uniswap,
                    ERC20BridgeSource.Native,
                    ERC20BridgeSource.Native,
                ];
                expect(orderSources.sort()).to.deep.eq(expectedSources.sort());
            });

            const ETH_TO_MAKER_RATE = 1.5;

            it('factors in fees for native orders', async () => {
                // Native orders will have the best rates but have fees,
                // dropping their effective rates.
                const nativeFeeRate = 0.06;
                const rates: RatesBySource = {
                    [ERC20BridgeSource.Native]: [1, 0.99, 0.98, 0.97], // Effectively [0.94, 0.93, 0.92, 0.91]
                    [ERC20BridgeSource.Uniswap]: [0.96, 0.1, 0.1, 0.1],
                    [ERC20BridgeSource.Eth2Dai]: [0.95, 0.1, 0.1, 0.1],
                    [ERC20BridgeSource.Kyber]: [0.1, 0.1, 0.1, 0.1],
                };
                const feeSchedule = {
                    [ERC20BridgeSource.Native]: _.constant(
                        FILL_AMOUNT.div(4)
                            .times(nativeFeeRate)
                            .dividedToIntegerBy(ETH_TO_MAKER_RATE),
                    ),
                };
                replaceSamplerOps({
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                    getMedianSellRate: createGetMedianSellRate(ETH_TO_MAKER_RATE),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketSellOrdersAsync(
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, feeSchedule },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [
                    ERC20BridgeSource.Native,
                    ERC20BridgeSource.Uniswap,
                    ERC20BridgeSource.Eth2Dai,
                    ERC20BridgeSource.Native,
                ];
                expect(orderSources.sort()).to.deep.eq(expectedSources.sort());
            });

            it('factors in fees for dexes', async () => {
                // Kyber will have the best rates but will have fees,
                // dropping its effective rates.
                const uniswapFeeRate = 0.2;
                const rates: RatesBySource = {
                    [ERC20BridgeSource.Native]: [0.95, 0.1, 0.1, 0.1],
                    [ERC20BridgeSource.Kyber]: [0.1, 0.1, 0.1, 0.1],
                    [ERC20BridgeSource.Eth2Dai]: [0.92, 0.1, 0.1, 0.1],
                    // Effectively [0.8, ~0.5, ~0, ~0]
                    [ERC20BridgeSource.Uniswap]: [1, 0.7, 0.2, 0.2],
                };
                const feeSchedule = {
                    [ERC20BridgeSource.Uniswap]: _.constant(
                        FILL_AMOUNT.div(4)
                            .times(uniswapFeeRate)
                            .dividedToIntegerBy(ETH_TO_MAKER_RATE),
                    ),
                };
                replaceSamplerOps({
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                    getMedianSellRate: createGetMedianSellRate(ETH_TO_MAKER_RATE),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketSellOrdersAsync(
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, feeSchedule },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [
                    ERC20BridgeSource.Native,
                    ERC20BridgeSource.Eth2Dai,
                    ERC20BridgeSource.Uniswap,
                ];
                expect(orderSources.sort()).to.deep.eq(expectedSources.sort());
            });

            it('can mix one concave source', async () => {
                const rates: RatesBySource = {
                    [ERC20BridgeSource.Kyber]: [0, 0, 0, 0], // Won't use
                    [ERC20BridgeSource.Eth2Dai]: [0.5, 0.85, 0.75, 0.75], // Concave
                    [ERC20BridgeSource.Uniswap]: [0.96, 0.2, 0.1, 0.1],
                    [ERC20BridgeSource.Native]: [0.95, 0.2, 0.2, 0.1],
                };
                replaceSamplerOps({
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                    getMedianSellRate: createGetMedianSellRate(ETH_TO_MAKER_RATE),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketSellOrdersAsync(
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4 },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [
                    ERC20BridgeSource.Eth2Dai,
                    ERC20BridgeSource.Uniswap,
                    ERC20BridgeSource.Native,
                ];
                expect(orderSources.sort()).to.deep.eq(expectedSources.sort());
            });

            it('fallback orders use different sources', async () => {
                const rates: RatesBySource = {};
                rates[ERC20BridgeSource.Native] = [0.9, 0.8, 0.5, 0.5];
                rates[ERC20BridgeSource.Uniswap] = [0.6, 0.05, 0.01, 0.01];
                rates[ERC20BridgeSource.Eth2Dai] = [0.4, 0.3, 0.01, 0.01];
                rates[ERC20BridgeSource.Kyber] = [0.35, 0.2, 0.01, 0.01];
                replaceSamplerOps({
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketSellOrdersAsync(
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, allowFallback: true },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const firstSources = orderSources.slice(0, 4);
                const secondSources = orderSources.slice(4);
                expect(_.intersection(firstSources, secondSources)).to.be.length(0);
            });

            it('does not create a fallback if below maxFallbackSlippage', async () => {
                const rates: RatesBySource = {};
                rates[ERC20BridgeSource.Native] = [1, 1, 0.01, 0.01];
                rates[ERC20BridgeSource.Uniswap] = [1, 1, 0.01, 0.01];
                rates[ERC20BridgeSource.Eth2Dai] = [0.49, 0.49, 0.49, 0.49];
                rates[ERC20BridgeSource.Kyber] = [0.35, 0.2, 0.01, 0.01];
                replaceSamplerOps({
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketSellOrdersAsync(
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, allowFallback: true, maxFallbackSlippage: 0.25 },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const firstSources = [ERC20BridgeSource.Native, ERC20BridgeSource.Native, ERC20BridgeSource.Uniswap];
                const secondSources: ERC20BridgeSource[] = [];
                expect(orderSources.slice(0, firstSources.length).sort()).to.deep.eq(firstSources.sort());
                expect(orderSources.slice(firstSources.length).sort()).to.deep.eq(secondSources.sort());
            });

            it('is able to create a order from LiquidityProvider', async () => {
                const registryAddress = randomAddress();
                const liquidityProviderAddress = (DEFAULT_FILL_DATA[ERC20BridgeSource.LiquidityProvider] as any)
                    .poolAddress;
                const xAsset = randomAddress();
                const yAsset = randomAddress();
                const toSell = fromTokenUnitAmount(10);

                const [getSellQuotesParams, getSellQuotesFn] = callTradeOperationAndRetainLiquidityProviderParams(
                    createGetMultipleSellQuotesOperationFromRates,
                    {
                        [ERC20BridgeSource.LiquidityProvider]: createDecreasingRates(5),
                    },
                );

                replaceSamplerOps({
                    getOrderFillableTakerAmounts: () => [constants.ZERO_AMOUNT],
                    getSellQuotes: getSellQuotesFn,
                });

                const sampler = new MarketOperationUtils(
                    MOCK_SAMPLER,
                    contractAddresses,
                    ORDER_DOMAIN,
                    registryAddress,
                );
                const ordersAndReport = await sampler.getMarketSellOrdersAsync(
                    [
                        createOrder({
                            makerAssetData: assetDataUtils.encodeERC20AssetData(xAsset),
                            takerAssetData: assetDataUtils.encodeERC20AssetData(yAsset),
                        }),
                    ],
                    Web3Wrapper.toBaseUnitAmount(10, 18),
                    {
                        excludedSources: SELL_SOURCES.concat(ERC20BridgeSource.Bancor),
                        numSamples: 4,
                        bridgeSlippage: 0,
                    },
                );
                const result = ordersAndReport.optimizedOrders;
                expect(result.length).to.eql(1);
                expect(result[0].makerAddress).to.eql(liquidityProviderAddress);

                // tslint:disable-next-line:no-unnecessary-type-assertion
                const decodedAssetData = assetDataUtils.decodeAssetDataOrThrow(
                    result[0].makerAssetData,
                ) as ERC20BridgeAssetData;
                expect(decodedAssetData.assetProxyId).to.eql(AssetProxyId.ERC20Bridge);
                expect(decodedAssetData.bridgeAddress).to.eql(liquidityProviderAddress);
                expect(result[0].takerAssetAmount).to.bignumber.eql(toSell);
                expect(getSellQuotesParams.sources).contains(ERC20BridgeSource.LiquidityProvider);
                expect(getSellQuotesParams.liquidityProviderAddress).is.eql(registryAddress);
            });

            it('factors in exchange proxy gas overhead', async () => {
                // Uniswap has a slightly better rate than LiquidityProvider,
                // but LiquidityProvider is better accounting for the EP gas overhead.
                const rates: RatesBySource = {
                    [ERC20BridgeSource.Native]: [0.01, 0.01, 0.01, 0.01],
                    [ERC20BridgeSource.Uniswap]: [1, 1, 1, 1],
                    [ERC20BridgeSource.LiquidityProvider]: [0.9999, 0.9999, 0.9999, 0.9999],
                };
                replaceSamplerOps({
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                    getMedianSellRate: createGetMedianSellRate(ETH_TO_MAKER_RATE),
                });
                const optimizer = new MarketOperationUtils(
                    MOCK_SAMPLER,
                    contractAddresses,
                    ORDER_DOMAIN,
                    randomAddress(), // liquidity provider registry
                );
                const gasPrice = 100e9; // 100 gwei
                const exchangeProxyOverhead = (sourceFlags: number) =>
                    sourceFlags === SOURCE_FLAGS.LiquidityProvider
                        ? new BigNumber(3e4).times(gasPrice)
                        : new BigNumber(1.3e5).times(gasPrice);
                const improvedOrdersResponse = await optimizer.getMarketSellOrdersAsync(
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    {
                        ...DEFAULT_OPTS,
                        numSamples: 4,
                        excludedSources: [
                            ...DEFAULT_OPTS.excludedSources,
                            ERC20BridgeSource.Eth2Dai,
                            ERC20BridgeSource.Kyber,
                            ERC20BridgeSource.Bancor,
                        ],
                        exchangeProxyOverhead,
                    },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [ERC20BridgeSource.LiquidityProvider];
                expect(orderSources).to.deep.eq(expectedSources);
            });
        });

        describe('getMarketBuyOrdersAsync()', () => {
            const FILL_AMOUNT = new BigNumber('100e18');
            const ORDERS = createOrdersFromBuyRates(
                FILL_AMOUNT,
                _.times(NUM_SAMPLES, () => DEFAULT_RATES[ERC20BridgeSource.Native][0]),
            );
            const DEFAULT_OPTS = {
                numSamples: NUM_SAMPLES,
                sampleDistributionBase: 1,
                bridgeSlippage: 0,
                maxFallbackSlippage: 100,
                excludedSources: DEFAULT_EXCLUDED,
                allowFallback: false,
            };

            beforeEach(() => {
                replaceSamplerOps();
            });

            it('queries `numSamples` samples', async () => {
                const numSamples = _.random(1, 16);
                let actualNumSamples = 0;
                replaceSamplerOps({
                    getBuyQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        actualNumSamples = amounts.length;
                        return DEFAULT_OPS.getBuyQuotes(sources, makerToken, takerToken, amounts, wethAddress);
                    },
                });
                await marketOperationUtils.getMarketBuyOrdersAsync(ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    numSamples,
                });
                expect(actualNumSamples).eq(numSamples);
            });

            it('polls all DEXes if `excludedSources` is empty', async () => {
                let sourcesPolled: ERC20BridgeSource[] = [];
                replaceSamplerOps({
                    getBuyQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        sourcesPolled = sourcesPolled.concat(sources.slice());
                        return DEFAULT_OPS.getBuyQuotes(sources, makerToken, takerToken, amounts, wethAddress);
                    },
                    getTwoHopBuyQuotes: (sources: ERC20BridgeSource[], ..._args: any[]) => {
                        if (sources.length !== 0) {
                            sourcesPolled.push(ERC20BridgeSource.MultiHop);
                            sourcesPolled.push(...sources);
                        }
                        return DEFAULT_OPS.getTwoHopBuyQuotes(..._args);
                    },
                    getBalancerBuyQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        makerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Balancer);
                        return DEFAULT_OPS.getBalancerBuyQuotesOffChainAsync(makerToken, takerToken, makerFillAmounts);
                    },
                });
                await marketOperationUtils.getMarketBuyOrdersAsync(ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    excludedSources: [],
                });
                expect(_.uniq(sourcesPolled).sort()).to.deep.equals(BUY_SOURCES.sort());
            });

            it('polls the liquidity provider when the registry is provided in the arguments', async () => {
                const [args, fn] = callTradeOperationAndRetainLiquidityProviderParams(
                    createGetMultipleBuyQuotesOperationFromRates,
                    DEFAULT_RATES,
                );
                replaceSamplerOps({
                    getBuyQuotes: fn,
                    getTwoHopBuyQuotes: (sources: ERC20BridgeSource[], ..._args: any[]) => {
                        if (sources.length !== 0) {
                            args.sources.push(ERC20BridgeSource.MultiHop);
                            args.sources.push(...sources);
                        }
                        return DEFAULT_OPS.getTwoHopBuyQuotes(..._args);
                    },
                    getBalancerBuyQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        makerFillAmounts: BigNumber[],
                    ) => {
                        args.sources = args.sources.concat(ERC20BridgeSource.Balancer);
                        return DEFAULT_OPS.getBalancerBuyQuotesOffChainAsync(makerToken, takerToken, makerFillAmounts);
                    },
                });
                const registryAddress = randomAddress();
                const newMarketOperationUtils = new MarketOperationUtils(
                    MOCK_SAMPLER,
                    contractAddresses,
                    ORDER_DOMAIN,
                    registryAddress,
                );
                await newMarketOperationUtils.getMarketBuyOrdersAsync(ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    excludedSources: [],
                });
                expect(_.uniq(args.sources).sort()).to.deep.eq(
                    BUY_SOURCES.concat([ERC20BridgeSource.LiquidityProvider]).sort(),
                );
                expect(args.liquidityProviderAddress).to.eql(registryAddress);
            });

            it('does not poll DEXes in `excludedSources`', async () => {
                const excludedSources = [ERC20BridgeSource.Uniswap, ERC20BridgeSource.Eth2Dai];
                let sourcesPolled: ERC20BridgeSource[] = [];
                replaceSamplerOps({
                    getBuyQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        sourcesPolled = sourcesPolled.concat(sources.slice());
                        return DEFAULT_OPS.getBuyQuotes(sources, makerToken, takerToken, amounts, wethAddress);
                    },
                    getTwoHopBuyQuotes: (sources: ERC20BridgeSource[], ..._args: any[]) => {
                        if (sources.length !== 0) {
                            sourcesPolled.push(ERC20BridgeSource.MultiHop);
                            sourcesPolled.push(...sources);
                        }
                        return DEFAULT_OPS.getTwoHopBuyQuotes(..._args);
                    },
                    getBalancerBuyQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        makerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Balancer);
                        return DEFAULT_OPS.getBalancerBuyQuotesOffChainAsync(makerToken, takerToken, makerFillAmounts);
                    },
                });
                await marketOperationUtils.getMarketBuyOrdersAsync(ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    excludedSources,
                });
                expect(_.uniq(sourcesPolled).sort()).to.deep.eq(_.without(BUY_SOURCES, ...excludedSources).sort());
            });

            it('only polls DEXes in `includedSources`', async () => {
                const includedSources = [ERC20BridgeSource.Uniswap, ERC20BridgeSource.Eth2Dai];
                let sourcesPolled: ERC20BridgeSource[] = [];
                replaceSamplerOps({
                    getBuyQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        sourcesPolled = sourcesPolled.concat(sources.slice());
                        return DEFAULT_OPS.getBuyQuotes(sources, makerToken, takerToken, amounts, wethAddress);
                    },
                    getTwoHopBuyQuotes: (sources: ERC20BridgeSource[], ..._args: any[]) => {
                        if (sources.length !== 0) {
                            sourcesPolled.push(ERC20BridgeSource.MultiHop);
                            sourcesPolled.push(...sources);
                        }
                        return DEFAULT_OPS.getTwoHopBuyQuotes(..._args);
                    },
                    getBalancerBuyQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        makerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Balancer);
                        return DEFAULT_OPS.getBalancerBuyQuotesOffChainAsync(makerToken, takerToken, makerFillAmounts);
                    },
                });
                await marketOperationUtils.getMarketBuyOrdersAsync(ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    excludedSources: [],
                    includedSources,
                });
                expect(_.uniq(sourcesPolled).sort()).to.deep.eq(includedSources.sort());
            });

            it('generates bridge orders with correct asset data', async () => {
                const improvedOrdersResponse = await marketOperationUtils.getMarketBuyOrdersAsync(
                    // Pass in empty orders to prevent native orders from being used.
                    ORDERS.map(o => ({ ...o, makerAssetAmount: constants.ZERO_AMOUNT })),
                    FILL_AMOUNT,
                    DEFAULT_OPTS,
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                expect(improvedOrders).to.not.be.length(0);
                for (const order of improvedOrders) {
                    expect(getSourceFromAssetData(order.makerAssetData)).to.exist('');
                    const makerAssetDataPrefix = hexUtils.slice(
                        assetDataUtils.encodeERC20BridgeAssetData(
                            MAKER_TOKEN,
                            constants.NULL_ADDRESS,
                            constants.NULL_BYTES,
                        ),
                        0,
                        36,
                    );
                    assertSamePrefix(order.makerAssetData, makerAssetDataPrefix);
                    expect(order.takerAssetData).to.eq(TAKER_ASSET_DATA);
                }
            });

            it('generates bridge orders with correct maker amount', async () => {
                const improvedOrdersResponse = await marketOperationUtils.getMarketBuyOrdersAsync(
                    // Pass in empty orders to prevent native orders from being used.
                    ORDERS.map(o => ({ ...o, makerAssetAmount: constants.ZERO_AMOUNT })),
                    FILL_AMOUNT,
                    DEFAULT_OPTS,
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const totalMakerAssetAmount = BigNumber.sum(...improvedOrders.map(o => o.makerAssetAmount));
                expect(totalMakerAssetAmount).to.bignumber.gte(FILL_AMOUNT);
            });

            it('generates bridge orders with max slippage of `bridgeSlippage`', async () => {
                const bridgeSlippage = _.random(0.1, true);
                const improvedOrdersResponse = await marketOperationUtils.getMarketBuyOrdersAsync(
                    // Pass in empty orders to prevent native orders from being used.
                    ORDERS.map(o => ({ ...o, makerAssetAmount: constants.ZERO_AMOUNT })),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, bridgeSlippage },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                expect(improvedOrders).to.not.be.length(0);
                for (const order of improvedOrders) {
                    const expectedTakerAmount = order.fills[0].output;
                    const slippage = order.takerAssetAmount.div(expectedTakerAmount.plus(1)).minus(1);
                    assertRoughlyEquals(slippage, bridgeSlippage, 1);
                }
            });

            it('can mix convex sources', async () => {
                const rates: RatesBySource = { ...ZERO_RATES };
                rates[ERC20BridgeSource.Native] = [0.4, 0.3, 0.2, 0.1];
                rates[ERC20BridgeSource.Uniswap] = [0.5, 0.05, 0.05, 0.05];
                rates[ERC20BridgeSource.Eth2Dai] = [0.6, 0.05, 0.05, 0.05];
                replaceSamplerOps({
                    getBuyQuotes: createGetMultipleBuyQuotesOperationFromRates(rates),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketBuyOrdersAsync(
                    createOrdersFromBuyRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4 },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [
                    ERC20BridgeSource.Eth2Dai,
                    ERC20BridgeSource.Uniswap,
                    ERC20BridgeSource.Native,
                    ERC20BridgeSource.Native,
                ];
                expect(orderSources.sort()).to.deep.eq(expectedSources.sort());
            });

            const ETH_TO_TAKER_RATE = 1.5;

            it('factors in fees for native orders', async () => {
                // Native orders will have the best rates but have fees,
                // dropping their effective rates.
                const nativeFeeRate = 0.06;
                const rates: RatesBySource = {
                    ...ZERO_RATES,
                    [ERC20BridgeSource.Native]: [1, 0.99, 0.98, 0.97], // Effectively [0.94, ~0.93, ~0.92, ~0.91]
                    [ERC20BridgeSource.Uniswap]: [0.96, 0.1, 0.1, 0.1],
                    [ERC20BridgeSource.Eth2Dai]: [0.95, 0.1, 0.1, 0.1],
                    [ERC20BridgeSource.Kyber]: [0.1, 0.1, 0.1, 0.1],
                };
                const feeSchedule = {
                    [ERC20BridgeSource.Native]: _.constant(
                        FILL_AMOUNT.div(4)
                            .times(nativeFeeRate)
                            .dividedToIntegerBy(ETH_TO_TAKER_RATE),
                    ),
                };
                replaceSamplerOps({
                    getBuyQuotes: createGetMultipleBuyQuotesOperationFromRates(rates),
                    getMedianSellRate: createGetMedianSellRate(ETH_TO_TAKER_RATE),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketBuyOrdersAsync(
                    createOrdersFromBuyRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, feeSchedule },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [
                    ERC20BridgeSource.Uniswap,
                    ERC20BridgeSource.Eth2Dai,
                    ERC20BridgeSource.Native,
                    ERC20BridgeSource.Native,
                ];
                expect(orderSources.sort()).to.deep.eq(expectedSources.sort());
            });

            it('factors in fees for dexes', async () => {
                // Uniswap will have the best rates but will have fees,
                // dropping its effective rates.
                const uniswapFeeRate = 0.2;
                const rates: RatesBySource = {
                    ...ZERO_RATES,
                    [ERC20BridgeSource.Native]: [0.95, 0.1, 0.1, 0.1],
                    // Effectively [0.8, ~0.5, ~0, ~0]
                    [ERC20BridgeSource.Uniswap]: [1, 0.7, 0.2, 0.2],
                    [ERC20BridgeSource.Eth2Dai]: [0.92, 0.1, 0.1, 0.1],
                };
                const feeSchedule = {
                    [ERC20BridgeSource.Uniswap]: _.constant(
                        FILL_AMOUNT.div(4)
                            .times(uniswapFeeRate)
                            .dividedToIntegerBy(ETH_TO_TAKER_RATE),
                    ),
                };
                replaceSamplerOps({
                    getBuyQuotes: createGetMultipleBuyQuotesOperationFromRates(rates),
                    getMedianSellRate: createGetMedianSellRate(ETH_TO_TAKER_RATE),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketBuyOrdersAsync(
                    createOrdersFromBuyRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, feeSchedule },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [
                    ERC20BridgeSource.Native,
                    ERC20BridgeSource.Eth2Dai,
                    ERC20BridgeSource.Uniswap,
                ];
                expect(orderSources.sort()).to.deep.eq(expectedSources.sort());
            });

            it('fallback orders use different sources', async () => {
                const rates: RatesBySource = { ...ZERO_RATES };
                rates[ERC20BridgeSource.Native] = [0.9, 0.8, 0.5, 0.5];
                rates[ERC20BridgeSource.Uniswap] = [0.6, 0.05, 0.01, 0.01];
                rates[ERC20BridgeSource.Eth2Dai] = [0.4, 0.3, 0.01, 0.01];
                replaceSamplerOps({
                    getBuyQuotes: createGetMultipleBuyQuotesOperationFromRates(rates),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketBuyOrdersAsync(
                    createOrdersFromBuyRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, allowFallback: true },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const firstSources = orderSources.slice(0, 4);
                const secondSources = orderSources.slice(4);
                expect(_.intersection(firstSources, secondSources)).to.be.length(0);
            });

            it('does not create a fallback if below maxFallbackSlippage', async () => {
                const rates: RatesBySource = { ...ZERO_RATES };
                rates[ERC20BridgeSource.Native] = [1, 1, 0.01, 0.01];
                rates[ERC20BridgeSource.Uniswap] = [1, 1, 0.01, 0.01];
                rates[ERC20BridgeSource.Eth2Dai] = [0.49, 0.49, 0.49, 0.49];
                replaceSamplerOps({
                    getBuyQuotes: createGetMultipleBuyQuotesOperationFromRates(rates),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketBuyOrdersAsync(
                    createOrdersFromBuyRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, allowFallback: true, maxFallbackSlippage: 0.25 },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const firstSources = [ERC20BridgeSource.Native, ERC20BridgeSource.Native, ERC20BridgeSource.Uniswap];
                const secondSources: ERC20BridgeSource[] = [];
                expect(orderSources.slice(0, firstSources.length).sort()).to.deep.eq(firstSources.sort());
                expect(orderSources.slice(firstSources.length).sort()).to.deep.eq(secondSources.sort());
            });

            it('factors in exchange proxy gas overhead', async () => {
                // Uniswap has a slightly better rate than LiquidityProvider,
                // but LiquidityProvider is better accounting for the EP gas overhead.
                const rates: RatesBySource = {
                    [ERC20BridgeSource.Native]: [0.01, 0.01, 0.01, 0.01],
                    [ERC20BridgeSource.Uniswap]: [1, 1, 1, 1],
                    [ERC20BridgeSource.LiquidityProvider]: [0.9999, 0.9999, 0.9999, 0.9999],
                };
                replaceSamplerOps({
                    getBuyQuotes: createGetMultipleBuyQuotesOperationFromRates(rates),
                    getMedianSellRate: createGetMedianSellRate(ETH_TO_TAKER_RATE),
                });
                const optimizer = new MarketOperationUtils(
                    MOCK_SAMPLER,
                    contractAddresses,
                    ORDER_DOMAIN,
                    randomAddress(), // liquidity provider registry
                );
                const gasPrice = 100e9; // 100 gwei
                const exchangeProxyOverhead = (sourceFlags: number) =>
                    sourceFlags === SOURCE_FLAGS.LiquidityProvider
                        ? new BigNumber(3e4).times(gasPrice)
                        : new BigNumber(1.3e5).times(gasPrice);
                const improvedOrdersResponse = await optimizer.getMarketBuyOrdersAsync(
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    {
                        ...DEFAULT_OPTS,
                        numSamples: 4,
                        excludedSources: [
                            ...DEFAULT_OPTS.excludedSources,
                            ERC20BridgeSource.Eth2Dai,
                            ERC20BridgeSource.Kyber,
                        ],
                        exchangeProxyOverhead,
                    },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [ERC20BridgeSource.LiquidityProvider];
                expect(orderSources).to.deep.eq(expectedSources);
            });
        });
    });

    describe('createFills', () => {
        const takerAssetAmount = new BigNumber(5000000);
        const ethToOutputRate = new BigNumber(0.5);
        // tslint:disable-next-line:no-object-literal-type-assertion
        const smallOrder = {
            chainId: 1,
            makerAddress: 'SMALL_ORDER',
            takerAddress: NULL_ADDRESS,
            takerAssetAmount,
            makerAssetAmount: takerAssetAmount.times(2),
            makerFee: ZERO_AMOUNT,
            takerFee: ZERO_AMOUNT,
            makerAssetData: '0xf47261b0000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
            takerAssetData: '0xf47261b0000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            makerFeeAssetData: '0x',
            takerFeeAssetData: '0x',
            fillableTakerAssetAmount: takerAssetAmount,
            fillableMakerAssetAmount: takerAssetAmount.times(2),
            fillableTakerFeeAmount: ZERO_AMOUNT,
        } as SignedOrderWithFillableAmounts;
        const largeOrder = {
            ...smallOrder,
            makerAddress: 'LARGE_ORDER',
            fillableMakerAssetAmount: smallOrder.fillableMakerAssetAmount.times(2),
            fillableTakerAssetAmount: smallOrder.fillableTakerAssetAmount.times(2),
            makerAssetAmount: smallOrder.makerAssetAmount.times(2),
            takerAssetAmount: smallOrder.takerAssetAmount.times(2),
        };
        const orders = [smallOrder, largeOrder];
        const feeSchedule = {
            [ERC20BridgeSource.Native]: _.constant(2e5),
        };

        it('penalizes native fill based on target amount when target is smaller', () => {
            const path = createFills({
                side: MarketOperation.Sell,
                orders,
                dexQuotes: [],
                targetInput: takerAssetAmount.minus(1),
                ethToOutputRate,
                feeSchedule,
            });
            expect((path[0][0].fillData as NativeFillData).order.makerAddress).to.eq(smallOrder.makerAddress);
            expect(path[0][0].input).to.be.bignumber.eq(takerAssetAmount.minus(1));
        });

        it('penalizes native fill based on available amount when target is larger', () => {
            const path = createFills({
                side: MarketOperation.Sell,
                orders,
                dexQuotes: [],
                targetInput: POSITIVE_INF,
                ethToOutputRate,
                feeSchedule,
            });
            expect((path[0][0].fillData as NativeFillData).order.makerAddress).to.eq(largeOrder.makerAddress);
            expect((path[0][1].fillData as NativeFillData).order.makerAddress).to.eq(smallOrder.makerAddress);
        });
    });
});
// tslint:disable-next-line: max-file-line-count
